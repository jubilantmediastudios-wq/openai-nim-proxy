const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 10000;

// ==========================================
// CONFIGURATION
// ==========================================

// Security: Use Environment Variable first, fallback only for local testing
const NIM_API_KEY = process.env.NIM_API_KEY || "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";

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// Toggle to show/hide the <think> reasoning tags in Janitor
const SHOW_REASONING = true; 

// Toggle to send the 'thinking' parameter (only for specific DeepSeek models)
const ENABLE_THINKING_MODE = true; 

// ==========================================
// MODEL MAPPING (UPDATED FOR 2026)
// ==========================================
const MODEL_MAPPING = {
  // Use 'deepseek-v3' as it replaces the retired 'r1' IDs
  'deepseek': 'deepseek-ai/deepseek-v3.2',
  '3.2 deepseek': 'deepseek-ai/deepseek-v3',
  
  // High-performance fallbacks
  'gpt-4o': 'moonshotai/kimi-k2-thinking',
  'gpt-4': 'moonshotai/kimi-k2.5',
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-70b-instruct',
  'claude-3-opus': 'meta/llama-3.1-405b-instruct'
};

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// ==========================================
// ROUTES
// ==========================================

app.get('/health', (req, res) => {
  res.json({ status: 'online', service: 'NVIDIA NIM Proxy', active_key: !!NIM_API_KEY });
});

app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({ id, object: 'model', owned_by: 'proxy' }));
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Resolve correct model ID from mapping
    let targetModel = MODEL_MAPPING[model] || model;
    
    // Fallback logic for deepseek strings
    if (!MODEL_MAPPING[model] && model.toLowerCase().includes('deepseek')) {
        targetModel = 'deepseek-ai/deepseek-v3';
    }

    const upstreamRequest = {
      model: targetModel,
      messages: messages,
      temperature: temperature ?? 0.6,
      max_tokens: max_tokens ?? 4096,
      stream: stream || false
    };

    if (ENABLE_THINKING_MODE) {
       upstreamRequest.chat_template_kwargs = { thinking: true };
    }

    const response = await axios({
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      data: upstreamRequest,
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      let isThinking = false;

      response.data.on('data', (chunk) => {
        const lines = chunk.toString().split('\n');
        for (const line of lines) {
          if (!line.trim() || line.includes('[DONE]')) {
            if (line.includes('[DONE]')) res.write(line + '\n\n');
            continue;
          }

          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              const delta = data.choices?.[0]?.delta;
              if (delta) {
                let outContent = "";
                
                // Handle Reasoning/Thinking
                if (SHOW_REASONING && delta.reasoning_content) {
                  if (!isThinking) { outContent += '<think>\n'; isThinking = true; }
                  outContent += delta.reasoning_content;
                }
                
                // Handle normal content
                if (delta.content) {
                  if (isThinking) { outContent += '\n</think>\n\n'; isThinking = false; }
                  outContent += delta.content;
                }

                if (outContent) {
                  data.choices[0].delta = { content: outContent };
                  res.write(`data: ${JSON.stringify(data)}\n\n`);
                }
              }
            } catch (e) { /* Ignore partial JSON */ }
          }
        }
      });

      response.data.on('end', () => res.end());
    } else {
      // Non-streaming
      const choice = response.data.choices[0];
      let fullContent = choice.message.content || "";
      if (SHOW_REASONING && choice.message.reasoning_content) {
        fullContent = `<think>\n${choice.message.reasoning_content}\n</think>\n\n${fullContent}`;
      }
      response.data.choices[0].message.content = fullContent;
      delete response.data.choices[0].message.reasoning_content;
      res.json(response.data);
    }

  } catch (error) {
    // FIX: Optimized error logging to prevent "Circular Structure" crash
    console.error('Proxy Error:', error.message);
    if (error.response) {
      console.error('Upstream Status:', error.response.status);
      console.error('Upstream Data:', error.response.data); // Log object directly, no stringify
    }

    res.status(error.response?.status || 500).json({
      error: {
        message: error.response?.data?.detail || error.message,
        type: "upstream_error",
        code: error.response?.status || 500
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
});
