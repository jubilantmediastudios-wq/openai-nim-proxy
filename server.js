// server.js - OpenAI to NVIDIA NIM API Proxy
// Fixed: correctly flattens 'extra_body' for Axios to match Python SDK behavior
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// SETTINGS
const SHOW_REASONING = true;       // Set to true to show reasoning with <think> tags
const ENABLE_THINKING_MODE = true; // Set to true to enable chat_template_kwargs

// Model mapping
const MODEL_MAPPING = {
  // Ensure we catch various ways of typing it
  '3.2 deepseek': 'deepseek-ai/deepseek-v3.2',
  'deepseek 3.2': 'deepseek-ai/deepseek-v3.2',
  'deepseek': 'deepseek-ai/deepseek-v3.2',
  
  // Standard mappings
  'gpt-4': 'deepseek-ai/deepseek-v3.2',
  'gpt-4-turbo': 'moonshotai/kimi-k2-thinking',
  'gpt-4o': 'deepseek-ai/deepseek-v3.1-terminus',
  'claude-3-opus': 'deepseek-ai/deepseek-r1',
  'claude-3-sonnet': 'openai/gpt-oss-20b',
  'deepseek-ai/deepseek-v3.1-terminus': 'qwen/qwen3-next-80b-a3b-thinking' 
};

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'OpenAI to NVIDIA NIM Proxy' });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id, object: 'model', created: Date.now(), owned_by: 'proxy'
  }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // 1. Resolve Model ID (Case insensitive safe match)
    const modelKey = model.toLowerCase(); // handle "3.2 DeepSeek" vs "3.2 deepseek"
    let nimModel = MODEL_MAPPING[modelKey] || MODEL_MAPPING[model] || model;
    
    // Fallback if mapping missed
    if (!MODEL_MAPPING[modelKey] && !nimModel.includes('/')) {
        if (modelKey.includes('deepseek')) nimModel = 'deepseek-ai/deepseek-v3.2';
        else nimModel = 'meta/llama-3.1-405b-instruct';
    }

    // 2. Prepare Request
    // FIXED: We do NOT use 'extra_body' as a key here. We merge directly.
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 8192,
      stream: stream || false
    };

    // 3. Inject Thinking Parameter (Correctly placed at root)
    if (ENABLE_THINKING_MODE || nimModel.includes('deepseek') || nimModel.includes('kimi')) {
        nimRequest.chat_template_kwargs = { thinking: true };
    }
    
    // 4. Send to NVIDIA
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    // 5. Handle Response
    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) { res.write(line + '\n'); return; }
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combined = '';
                  // Handle reasoning start/continuation
                  if (reasoning) {
                    if (!reasoningStarted) { combined = '<think>\n' + reasoning; reasoningStarted = true; }
                    else { combined = reasoning; }
                  }
                  // Handle switching to content
                  if (content) {
                    if (reasoningStarted) { combined += '</think>\n\n' + content; reasoningStarted = false; }
                    else { combined += content; }
                  }
                  
                  if (combined) {
                    data.choices[0].delta.content = combined;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                   if (!content) data.choices[0].delta.content = ''; // Keep alive
                   delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) { res.write(line + '\n'); }
          }
        });
      });
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => res.end());
    } else {
      // Non-streaming
      const choice = response.data.choices[0];
      let content = choice.message?.content || '';
      if (SHOW_REASONING && choice.message?.reasoning_content) {
        content = '<think>\n' + choice.message.reasoning_content + '\n</think>\n\n' + content;
      }
      res.json({
        id: response.data.id,
        object: 'chat.completion',
        created: response.data.created,
        model: nimModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: content },
          finish_reason: choice.finish_reason
        }]
      });
    }
  } catch (error) {
    console.error('Proxy Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message,
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Endpoint ${req.path} not found`, type: 'invalid_request_error', code: 404 } });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
