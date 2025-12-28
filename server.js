// server.js - OpenAI to NVIDIA NIM API Proxy
// "Nuclear Fix" Version - Forces correct parameters and IDs

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// CONSTANTS
// Hardcoded to ensure no environment variable mistakes
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY; // Only this needs to be in Render Env Vars

// SETTINGS
const SHOW_REASONING = true;
const ENABLE_THINKING_MODE = true; 

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'DeepSeek Proxy' });
});

// LIST MODELS
app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: [{ id: 'deepseek-ai/deepseek-v3.2', object: 'model', created: Date.now(), owned_by: 'nvidia' }]
  });
});

// CHAT ENDPOINT
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    console.log(`[Incoming Request] User requested: ${model}`);

    // ==================================================
    // 1. FORCED MODEL SELECTION
    // ==================================================
    let finalModel = model;
    const lowerModel = model.toLowerCase();

    // Logic: If it looks like deepseek, FORCE the exact ID from your working Python code
    if (lowerModel.includes('deepseek')) {
        finalModel = 'deepseek-ai/deepseek-v3.2';
    } 
    // Logic: If it looks like Kimi
    else if (lowerModel.includes('kimi')) {
        finalModel = 'moonshotai/kimi-k2-thinking';
    } 
    // Logic: Fallback for "gpt-4" etc
    else if (lowerModel.includes('gpt')) {
        finalModel = 'deepseek-ai/deepseek-v3.2';
    }

    console.log(`[Mapping] Forwarding to NVIDIA as: ${finalModel}`);

    // ==================================================
    // 2. CONSTRUCT REQUEST (Fixed Structure)
    // ==================================================
    const nimRequest = {
      model: finalModel,
      messages: messages,
      temperature: temperature || 0.6,
      max_tokens: max_tokens || 8192,
      stream: stream || false
    };

    // FIXED: JavaScript Axios sends JSON directly. 
    // We do NOT use 'extra_body' key here (that is for Python SDK).
    // We inject the parameters directly into the root object.
    if (ENABLE_THINKING_MODE || finalModel.includes('deepseek')) {
        nimRequest.chat_template_kwargs = { thinking: true };
    }

    // ==================================================
    // 3. SEND TO NVIDIA
    // ==================================================
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json'
    });
    
    // ==================================================
    // 4. HANDLE RESPONSE
    // ==================================================
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
                const delta = data.choices[0].delta;
                
                if (SHOW_REASONING) {
                  let text = '';
                  // Formatting logic
                  if (delta.reasoning_content) {
                    if (!reasoningStarted) { text = '<think>\n' + delta.reasoning_content; reasoningStarted = true; }
                    else { text = delta.reasoning_content; }
                  }
                  if (delta.content) {
                    if (reasoningStarted) { text += '</think>\n\n' + delta.content; reasoningStarted = false; }
                    else { text += delta.content; }
                  }
                  
                  if (text) {
                    delta.content = text;
                    delete delta.reasoning_content;
                  }
                } else {
                  // Always strip reasoning_content so it doesn't break Janitor
                  delete delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\n\n`);
            } catch (e) { res.write(line + '\n'); }
          }
        });
      });
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => { console.error('Stream Error', err); res.end(); });

    } else {
      // Non-streaming logic
      const choice = response.data.choices[0];
      let content = choice.message?.content || '';
      
      if (SHOW_REASONING && choice.message?.reasoning_content) {
        content = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${content}`;
      }

      res.json({
        id: response.data.id,
        object: 'chat.completion',
        created: response.data.created,
        model: finalModel,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: content },
          finish_reason: choice.finish_reason
        }],
        usage: response.data.usage
      });
    }

  } catch (error) {
    // LOGGING: This will appear in your Render logs to help debug
    console.error('================ ERROR LOG ================');
    console.error('Proxy Error Message:', error.message);
    if (error.response) {
        console.error('NVIDIA Status:', error.response.status);
        console.error('NVIDIA Data:', JSON.stringify(error.response.data));
    }
    console.error('===========================================');
    
    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.error?.message || error.message || 'Internal Proxy Error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch 404s for wrong paths
app.all('*', (req, res) => {
  res.status(404).json({ error: { message: `Path ${req.path} not found. Use /v1/chat/completions`, code: 404 } });
});

app.listen(PORT, () => console.log(`Proxy running on port ${PORT}`));
