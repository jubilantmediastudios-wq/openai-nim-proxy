// server.js - Bulletproof Version
// Mimics Python SDK behavior + Prevents 500 Crashes

const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' })); 
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 1. CONFIGURATION (Matches your working Python script)
const NIM_API_KEY = "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";
const TARGET_MODEL = "deepseek-ai/deepseek-v3.2";
const NIM_API_BASE = 'https://integrate.api.nvidia.com/v1';

app.get('/health', (req, res) => res.json({ status: 'ok', model: TARGET_MODEL }));
app.get('/v1/models', (req, res) => res.json({ object: 'list', data: [{ id: TARGET_MODEL, object: 'model' }] }));

app.post('/v1/chat/completions', async (req, res) => {
  try {
    console.log(`[Proxy] Request received. Forwarding to: ${TARGET_MODEL}`);

    // 2. PREPARE REQUEST
    const nimRequest = {
      model: TARGET_MODEL,
      messages: req.body.messages,
      temperature: 1,      // Matches Python
      top_p: 0.95,        // Matches Python
      max_tokens: 8192,
      stream: true,
      chat_template_kwargs: { thinking: true }
    };

    // 3. SEND TO NVIDIA (With Crash Prevention)
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'stream',
      // CRITICAL FIX: Do not throw error on 4xx/5xx status codes
      validateStatus: () => true 
    });

    // 4. CHECK FOR NVIDIA ERRORS
    if (response.status >= 400) {
      // If NVIDIA gave an error, read the stream and print it
      let errorData = '';
      response.data.on('data', chunk => errorData += chunk);
      response.data.on('end', () => {
        console.error(`[NVIDIA ERROR ${response.status}]:`, errorData);
        if (!res.headersSent) {
          res.status(response.status).json({ error: { message: `NVIDIA Error: ${errorData}`, code: response.status } });
        }
      });
      return; // Stop processing
    }

    // 5. STREAM BACK TO JANITOR (Success)
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    let buffer = '';
    let reasoningStarted = false;

    response.data.on('data', (chunk) => {
      const text = chunk.toString();
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      lines.forEach(line => {
        if (!line.startsWith('data: ')) return;
        if (line.includes('[DONE]')) {
          res.write(line + '\n\n');
          return;
        }

        try {
          const jsonStr = line.replace('data: ', '');
          const data = JSON.parse(jsonStr);
          const delta = data.choices?.[0]?.delta;

          if (delta) {
            // Handle Reasoning (Thinking)
            if (delta.reasoning_content) {
              if (!reasoningStarted) {
                delta.content = '<think>\n' + delta.reasoning_content;
                reasoningStarted = true;
              } else {
                delta.content = delta.reasoning_content;
              }
              delete delta.reasoning_content; // Clean up
            } else if (delta.content) {
              if (reasoningStarted) {
                delta.content = '</think>\n\n' + delta.content;
                reasoningStarted = false;
              }
            }
          }
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        } catch (e) {
          // Ignore parsing errors
        }
      });
    });

    response.data.on('end', () => res.end());

  } catch (error) {
    // This catches actual network failures (DNS, timeout), not 404s
    console.error('[CRITICAL PROXY ERROR]:', error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: "Internal Proxy Error", code: 500 } });
    }
  }
});

app.all('*', (req, res) => res.status(404).json({ error: "Endpoint not found" }));
app.listen(PORT, () => console.log(`Proxy running on ${PORT}`));
