const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const cors = require('cors');
const dotenv = require('dotenv');
const Ajv = require('ajv').default;
const tiktoken = require('tiktoken-node');
const DiffMatchPatch = require('diff-match-patch');
const crypto = require('crypto');
const path = require('path');

dotenv.config();
const app = express();

// Load prompt library with verification
const PROMPT_LIBRARY = (() => {
  const lib = require(path.join(__dirname, 'prompt_library'));
  const verifyChecksum = (content, expected) => {
    const hash = crypto.createHash('sha256').update(content).digest('hex');
    if (hash !== expected) throw new Error(`Prompt checksum mismatch`);
  };
  
  Object.entries(lib.checksums).forEach(([key, checksum]) => {
    verifyChecksum(lib[key], checksum);
  });
  
  return lib;
})();

// Initialize core components
const encoder = tiktoken.getEncoding("cl100k_base");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const ajv = new Ajv({ allErrors: true });

// Configuration
const AGENT_CONFIG = {
  maxIterations: 3,
  confidenceThreshold: 0.85,
  tokenSafetyMargin: 0.15
};

// Middleware
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400
}));
app.use(bodyParser.json({ limit: '50mb' }));

// ========== Agent Classes ==========

class ContextManager {
  constructor(modelConfig = {}) {
    this.modelConfig = { 
      max_tokens: 4000,
      ...modelConfig 
    };
    this.encoder = encoder;
  }

  calculateTokenBudget() {
    return Math.floor(this.modelConfig.max_tokens * (1 - AGENT_CONFIG.tokenSafetyMargin));
  }

  truncateToFit(content, reservedTokens = 0) {
    const maxTokens = this.calculateTokenBudget() - reservedTokens;
    const tokens = this.encoder.encode(content);
    return tokens.length > maxTokens 
      ? this.encoder.decode(tokens.slice(0, maxTokens))
      : content;
  }
}

class DiagnosticAgent {
  constructor(contextManager) {
    this.contextManager = contextManager;
    this.schema = {
        type: 'object',
        required: [
          "issue_identified", 
          "root_cause_analysis", 
          "prompt_changes", 
          "expected_impact", 
          "test_scenarios", 
          "model_configuration_analysis",
          "confidence_score"
        ],
        properties: {
          issue_identified: {
            type: 'string',
            description: "A clear, specific description of the exact issue detected in the chatbot's behavior, with concrete examples from the conversation."
          },
          root_cause_analysis: {
            type: 'string',
            description: "Comprehensive technical explanation of why the issue occurred, based on detailed analysis of the prompt, configured variables, skills, and execution logs."
          },
          model_configuration_analysis: {
            type: 'object',
            description: "Detailed analysis of how model and response configurations impact the chatbot's performance",
            properties: {
              configuration_impact: {
                type: 'string',
                description: "Explanation of how current model configurations contribute to the identified issue"
              },
              recommended_configuration_changes: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    parameter: {
                      type: 'string',
                      description: "Specific model or response configuration parameter to modify"
                    },
                    current_value: {
                      type: 'string',
                      description: "Current value of the parameter"
                    },
                    recommended_value: {
                      type: 'string',
                      description: "Suggested new value for the parameter"
                    },
                    rationale: {
                      type: 'string',
                      description: "Detailed explanation for why this configuration change is recommended"
                    }
                  }
                }
              },
              performance_limitations: {
                type: 'array',
                items: {
                  type: 'string',
                  description: "Specific limitations in the current model or response configuration that may be hindering performance"
                }
              }
            }
          },
          prompt_changes: {
            type: 'object',
            description: "Comprehensive and explicit details of all required prompt modifications that MUST be implemented exactly as specified.",
            properties: {
              modifications: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ["target", "path", "current", "updated", "reasoning"],
                  properties: {
                    target: {
                      type: 'string',
                      enum: ["dc_node_prompt", "variable_prompt", "model_configuration"]
                    },
                    path: {
                      type: 'string',
                      description: "Exact path/location within the component where the modification MUST be applied"
                    },
                    current: {
                      type: 'string', 
                      description: "Complete original text that MUST be replaced"
                    },
                    updated: {
                      type: 'string',
                      description: "Complete replacement text that MUST be inserted exactly as written"
                    },
                    reasoning: {
                      type: 'string',
                      description: "Detailed technical explanation of how this modification resolves the identified issue"
                    }
                  }
                }
              }
            }
          },
          expected_impact: {
            type: 'string',
            description: "Precise explanation of how the proposed changes will improve the chatbot's performance"
          },
          risks_and_tradeoffs: {
            type: 'string',
            description: "Comprehensive analysis of potential risks, unintended consequences, or trade-offs associated with implementing the proposed fixes"
          },
          test_scenarios: {
            type: 'array',
            items: {
              type: 'object',
              required: ["scenario", "user_input", "expected_outcome", "validation_criteria"],
              properties: {
                scenario: {
                  type: 'string',
                  description: "Detailed description of the test scenario"
                },
                user_input: {
                  type: 'string',
                  description: "Exact sample user input text for testing the fix"
                },
                expected_outcome: {
                  type: 'string',
                  description: "Precise description of the expected behavior after implementing the fix"
                },
                validation_criteria: {
                  type: 'string',
                  description: "Specific measurable criteria to determine if the fix was successful"
                }
              }
            }
          },
          implementation_guide: {
            type: 'object',
            properties: {
              priority: {
                type: 'string',
                enum: ["high", "medium", "low"]
              },
              difficulty: {
                type: 'string',
                enum: ["easy", "moderate", "complex"]
              },
              implementation_steps: {
                type: 'array',
                items: {
                  type: 'string'
                }
              }
            }
          },
          confidence_score: {
            type: 'string',
            description: "Assessment of confidence level that the proposed fixes will completely resolve the identified issues",
            enum: ["High", "Medium", "Low"]
          }
        }
      };
  }

  async analyze(inputs) {
    const prompt = this.buildAnalysisPrompt(inputs);
    const response = await this.queryLLM(prompt);
    return this.validateResponse(response);
  }

  buildAnalysisPrompt(inputs) {
    return `
      ${this.contextManager.truncateToFit(PROMPT_LIBRARY.system, 1500)}
      ${PROMPT_LIBRARY.architecture}
      ${PROMPT_LIBRARY.failureTypes}
      ${PROMPT_LIBRARY.antiPatterns}
      
      # CONVERSATION HISTORY
      ${JSON.stringify(inputs.conversationHistory, null, 2)}
      
      # BOT RESPONSE
      ${inputs.targetBotResponse}
      
      # USER FEEDBACK
      ${inputs.userFeedback}
      
      # CURRENT PROMPT
      ${inputs.dc_node_prompt}
      
      ${PROMPT_LIBRARY.outputFormat}
      
      IMPORTANT: Respond with raw JSON only. Do not include Markdown formatting, code blocks, or any text before or after the JSON.`;
  }

  async queryLLM(prompt) {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
      max_tokens: 2000
    });
    return response.choices[0].message.content;
  }

  validateResponse(response) {
    try {
      let cleanedResponse = response;
      if (response.includes('```')) {
        const jsonMatch = response.match(/```(?:json)?\s*([\s\S]*?)```/);
        if (jsonMatch && jsonMatch[1]) {
          cleanedResponse = jsonMatch[1].trim();
        }
      }
      
      const json = JSON.parse(cleanedResponse);
      const validate = ajv.compile(this.schema);
      
      if (!validate(json)) {
        throw new Error(`Invalid response: ${ajv.errorsText(validate.errors)}`);
      }
      return json;
    } catch (e) {
      console.error("Raw response:", response);
      throw new Error(`Response validation failed: ${e.message}`);
    }
  }
}

class PromptSurgeon {
  constructor() {
    this.dmp = new DiffMatchPatch();
  }

  applyModifications(originalPrompt, modifications) {
    return modifications.reduce((acc, mod) => {
      try {
        const patches = this.dmp.patch_make(acc, mod.updated);
        const [result, success] = this.dmp.patch_apply(patches, acc);
        if (!success.every(Boolean)) throw new Error('Patch application failed');
        return result;
      } catch (e) {
        console.error('Failed to apply modification:', mod);
        throw e;
      }
    }, originalPrompt);
  }
}

class OptimizationAgent {
  constructor(contextManager) {
    this.contextManager = contextManager;
  }

  compressPrompt(prompt) {
    const strategies = [
      this.removeRedundantInstructions,
      this.shortenExamples,
      this.optimizeFormatting
    ];
    
    let result = prompt;
    for (const strategy of strategies) {
      try {
        result = strategy.call(this, result);
      } catch (e) {
        console.warn(`Compression strategy failed: ${e.message}`);
      }
    }
    return result;
  }

  removeRedundantInstructions(prompt) {
    return prompt.replace(/(?:\n\s*-\s[^\n]*){3,}/g, match => {
      const items = match.split('\n').filter(Boolean);
      return items.slice(0, 3).join('\n') + '\n(...truncated similar items)';
    });
  }

  shortenExamples(prompt) {
    return prompt.replace(/(Example:\s*)(.*?)(?=\n\S|$)/gs, (_, prefix, content) => {
      return prefix + content.slice(0, 200) + (content.length > 200 ? '...' : '');
    });
  }

  optimizeFormatting(prompt) {
    return prompt
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^\s+$/gm, '');
  }
}

class ValidationAgent {
  constructor() {
    this.schema = {
      type: 'object',
      required: ['valid', 'confidence'],
      properties: {
        valid: { type: 'boolean' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        issues: { type: 'array', items: { type: 'string' } }
      }
    };
  }

  async validate(solution) {
    const validationPrompt = this.buildValidationPrompt(solution);
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: validationPrompt }],
      temperature: 0.3,
      max_tokens: 500
    });
    
    return this.parseValidationResult(response.choices[0].message.content);
  }

  buildValidationPrompt(solution) {
    return `${PROMPT_LIBRARY.system}
    
    Validate this prompt modification:
    ${JSON.stringify(solution, null, 2)}
    
    Check for:
    1. Instruction conflicts
    2. Skill execution compliance
    3. Token efficiency
    4. Output format compliance
    
    Respond with JSON:
    {
      "valid": boolean,
      "confidence": number (0-1),
      "issues": string[]
    }`;
  }

  parseValidationResult(response) {
    try {
      const result = JSON.parse(response);
      const validate = ajv.compile(this.schema);
      
      if (!validate(result)) {
        throw new Error(ajv.errorsText(validate.errors));
      }
      return result;
    } catch (e) {
      console.error('Invalid validation response:', response);
      return { valid: false, confidence: 0, issues: ['Validation failed'] };
    }
  }
}

class AgenticFramework {
  constructor(modelConfig = {}) {
    this.contextManager = new ContextManager(modelConfig);
    this.diagnosticAgent = new DiagnosticAgent(this.contextManager);
    this.surgeon = new PromptSurgeon();
    this.optimizer = new OptimizationAgent(this.contextManager);
    this.validator = new ValidationAgent();
  }

  async analyze(inputs) {
    let state = {
      dc_node_prompt: inputs.dc_node_prompt,
      conversationHistory: inputs.conversationHistory,
      targetBotResponse: inputs.targetBotResponse,
      userFeedback: inputs.userFeedback,
      iteration: 0,
      tokenUsage: []
    };

    for (let i = 0; i < AGENT_CONFIG.maxIterations; i++) {
      try {
        const diagnosis = await this.diagnosticAgent.analyze(state);
        const modifiedPrompt = this.surgeon.applyModifications(
          state.dc_node_prompt,
          diagnosis.prompt_changes.modifications
        );
        
        state.dc_node_prompt = this.optimizer.compressPrompt(modifiedPrompt);
        const validation = await this.validator.validate({
          original: inputs.dc_node_prompt,
          modified: state.dc_node_prompt,
          analysis: diagnosis
        });

        // Track token usage (initialize if undefined)
        const tokenUsage = validation.tokenUsage || 0;
        state.tokenUsage.push(tokenUsage);
        state.iteration++;

        if (validation.confidence >= AGENT_CONFIG.confidenceThreshold) {
          return {
            status: 'success',
            analysis: diagnosis,
            modified_prompt: state.dc_node_prompt,
            validation: validation,
            iterations: state.iteration,
            tokens_used: state.tokenUsage.reduce((a, b) => a + b, 0)
          };
        }
      } catch (e) {
        console.error(`Iteration ${i + 1} failed:`, e);
        state.lastError = e.message;
      }
    }

    return {
      status: 'max_iterations_reached',
      final_prompt: state.dc_node_prompt,
      iterations: state.iteration,
      tokens_used: state.tokenUsage.reduce((a, b) => a + b, 0),
      last_error: state.lastError || 'Unknown error'
    };
  }
}

// ========== API Endpoints ==========

app.post('/api/analyze-prompt', async (req, res) => {
  try {
    // Input validation
    const requiredFields = [
      'conversationHistory',
      'targetBotResponse',
      'userFeedback',
      'dc_node_prompt'
    ];
    
    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        error: 'Missing required fields',
        missing: missingFields
      });
    }

    // Process request
    const framework = new AgenticFramework(req.body.model_configuration);
    const result = await framework.analyze(req.body);
    
    if (result.status === 'success') {
      return res.status(200).json(result);
    } else {
      return res.status(422).json(result);
    }
  } catch (error) {
    console.error('API Error:', error);
    res.status(500).json({
      error: 'Internal server error',
      details: error.message
    });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Agentic Debugger API running on port ${PORT}`);
});

module.exports = { app, AgenticFramework };