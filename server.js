const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// CONFIGURATION
// ==========================================

// 1. API KEY SETUP (CRITICAL FIX)
// It looks for the key in your hosting Environment Variables first.
// If not found, it falls back to the hardcoded key (for local testing only).
const NIM_API_KEY = process.env.NIM_API_KEY || "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";

const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

// 2. BEHAVIOR TOGGLES
// Set to true to see the "Thinking" process in the chat (wrapped in <think> tags)
const SHOW_REASONING = true; 

// Set to true ONLY if using DeepSeek R1/V3 models that support the 'thinking' parameter.
// If you get 400 errors, set this to false.
const ENABLE_THINKING_MODE = true; 

// ==========================================
// MIDDLEWARE
// ==========================================

app.use(cors());
// FIX: Increased payload limit to prevent "413 Payload Too Large" errors
app.use(express.json({ limit: '100mb' })); 
app.use(express.urlencoded({ limit: '100mb', extended: true }));

// ==========================================
// MODEL MAPPING
// ==========================================
const MODEL_MAPPING = {
  // Maps Janitor/Client model names to NVIDIA NIM model IDs
  '3.2 deepseek': 'deepseek-ai/deepseek-v3.2', // Example ID
  'deepseek': 'deepseek-ai/deepseek-r1',
  'gpt-4': 'moonshotai/kimi-k2.5',
  'gpt-3.5-turbo': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
  'gpt-4o': 'deepseek-ai/deepseek-r1',
  'claude-3-opus': 'nvidia/llama-3.1-nemotron-70b-reward',
  // Add any specific mappings you need here
};

// ==========================================
// ROUTES
// ==========================================

// 1. Health Check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'online', 
    service: 'NVIDIA NIM Proxy', 
    configured: !!NIM_API_KEY 
  });
});

// 2. List Models (Standard OpenAI Endpoint)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(id => ({
    id: id,
    object: 'model',
    created: Date.now(),
    owned_by: 'proxy'
  }));
  res.json({ object: 'list', data: models });
});

// 3. Chat Completions (The Main Proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    // Resolve model ID
    let targetModel = MODEL_MAPPING[model] || model;
    
    // Fallback for generic 'deepseek' requests if not mapped
    if (model.toLowerCase().includes('deepseek') && !MODEL_MAPPING[model]) {
        targetModel = 'deepseek-ai/deepseek-r1';
    }

    // Construct Upstream Request
    const upstreamRequest = {
      model: targetModel,
      messages: messages,
      temperature: temperature ?? 0.6,
      max_tokens: max_tokens ?? 4096, // Increased default
      stream: stream || false
    };

    // Inject 'thinking' parameter only if enabled
    if (ENABLE_THINKING_MODE) {
       // Note: Only some NIM models support this specific param
       upstreamRequest.chat_template_kwargs = { thinking: true };
    }

    // Send Request to NVIDIA
    const response = await axios({
      method: 'post',
      url: `${NIM_API_BASE}/chat/completions`,
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': stream ? 'text/event-stream' : 'application/json'
      },
      data: upstreamRequest,
      responseType: stream ? 'stream' : 'json'
    });

    if (stream) {
      // HANDLE STREAMING RESPONSE
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let buffer = '';
      let isThinking = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        
        // Process complete lines from buffer
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim() || line.includes('[DONE]')) {
            if (line.includes('[DONE]')) res.write(line + '\n\n');
            continue;
          }

          if (line.startsWith('data: ')) {
            try {
              const jsonStr = line.slice(6);
              const data = JSON.parse(jsonStr);
              const delta = data.choices?.[0]?.delta;

              if (delta) {
                let contentToSend = '';

                // Handle Reasoning Content (The "Think" block)
                if (SHOW_REASONING && delta.reasoning_content) {
                  if (!isThinking) {
                    contentToSend += '<think>\n';
                    isThinking = true;
                  }
                  contentToSend += delta.reasoning_content;
                }
                
                // Handle Standard Content
                if (delta.content) {
                  if (isThinking) {
                    contentToSend += '\n</think>\n\n';
                    isThinking = false;
                  }
                  contentToSend += delta.content;
                }

                // Rewrite the chunk to send to client
                if (contentToSend) {
                  const newChunk = {
                    ...data,
                    choices: [{
                      ...data.choices[0],
                      delta: { content: contentToSend }
                    }]
                  };
                  res.write(`data: ${JSON.stringify(newChunk)}\n\n`);
                } else if (!delta.content && !delta.reasoning_content) {
                   // Keep alive or empty chunks
                   res.write(line + '\n\n');
                }
              }
            } catch (e) {
              // If JSON parse fails, ignore line
            }
          }
        }
      });

      response.data.on('end', () => {
        // Close thinking tag if still open at end of stream
        if (isThinking && SHOW_REASONING) {
           const closingChunk = {
             choices: [{ delta: { content: '\n</think>' } }]
           };
           res.write(`data: ${JSON.stringify(closingChunk)}\n\n`);
        }
        res.end();
      });

    } else {
      // HANDLE NON-STREAMING RESPONSE
      const choice = response.data.choices[0];
      let fullContent = choice.message.content || "";
      const reasoning = choice.message.reasoning_content;

      if (SHOW_REASONING && reasoning) {
        fullContent = `<think>\n${reasoning}\n</think>\n\n${fullContent}`;
      }

      // Modify response to standard OpenAI format
      response.data.choices[0].message.content = fullContent;
      // Remove reasoning_content so it doesn't confuse standard clients
      delete response.data.choices[0].message.reasoning_content;

      res.json(response.data);
    }

  } catch (error) {
    console.error('Proxy Error:', error.message);
    if (error.response) {
      console.error('Upstream Status:', error.response.status);
      console.error('Upstream Data:', JSON.stringify(error.response.data));
    }

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || "Proxy encountered an error",
        type: "proxy_error",
        code: error.response?.status || 500
      }
    });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 Proxy running on port ${PORT}`);
  console.log(`🔑 Key configured: ${NIM_API_KEY ? 'Yes (Hidden)' : 'No'}`);
});
