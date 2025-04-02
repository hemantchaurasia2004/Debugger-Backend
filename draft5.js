const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const _ = require('lodash');
const cors = require('cors');
const dotenv = require('dotenv');
const fs = require('fs').promises;
const path = require('path');
dotenv.config();

// Initialize Express app
const app = express();

// Configure CORS
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
  maxAge: 86400 // 24 hours
}));

// Add OPTIONS handler for preflight requests
app.options('/api/analyze-prompt', (req, res) => {
  res.status(200).end();
});

app.use(bodyParser.json({ limit: '50mb' }));

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Cache directory for storing analysis results
const CACHE_DIR = path.join(__dirname, 'analysis_cache');

// Ensure cache directory exists
async function ensureCacheDirectory() {
  try {
    await fs.mkdir(CACHE_DIR, { recursive: true });
  } catch (error) {
    console.error('Error creating cache directory:', error);
  }
}

ensureCacheDirectory();

/**
 * Main API endpoint for prompt analysis
 */
app.post('/api/analyze-prompt', async (req, res) => {
  try {
    const {
      conversationHistory,
      targetBotResponse,
      userFeedback,
      executionContext,
      dc_node_prompt,
      configured_variables,
      configured_skills,
      skill_execution_status,
      model_configuration,
      model_response_configuration
    } = req.body;

    // Validate required fields
    if (!conversationHistory || !targetBotResponse || !userFeedback) {
      return res.status(400).json({
        error: 'Missing required fields. Provide conversationHistory, targetBotResponse, and userFeedback.'
      });
    }

    // Validate required DC Node inputs
    if (!dc_node_prompt) {
      return res.status(400).json({
        error: 'Missing required DC Node prompt.'
      });
    }

    // Create a unique ID for this analysis request
    const analysisId = generateAnalysisId(conversationHistory, targetBotResponse, userFeedback);
    
    // Check if we have a cached result
    const cachedResult = await getCachedResult(analysisId);
    if (cachedResult && process.env.USE_CACHE === 'true') {
      return res.status(200).json(cachedResult);
    }

    // Create the agent context
    const agentContext = {
      analysisId,
      conversationHistory,
      targetBotResponse,
      userFeedback,
      executionContext,
      dc_node_prompt,
      configured_variables,
      configured_skills,
      skill_execution_status,
      model_configuration,
      model_response_configuration,
      workingMemory: {},
      analysisSteps: []
    };

    // Execute the agentic analysis pipeline
    const result = await executeAgentPipeline(agentContext);
    
    // Cache the result
    await cacheResult(analysisId, result);
    
    return res.status(200).json(result);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'An error occurred during prompt analysis',
      details: error.message
    });
  }
});

/**
 * Generate a unique ID for an analysis request
 */
function generateAnalysisId(conversationHistory, targetBotResponse, userFeedback) {
  const content = JSON.stringify({ 
    conversationHistory: conversationHistory.slice(-2), // Only use the latest exchanges for the ID
    targetResponse: targetBotResponse,
    feedback: userFeedback
  });
  
  // Simple hash function
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return `analysis_${Math.abs(hash).toString(16)}`;
}

/**
 * Check if we have a cached result for this analysis
 */
async function getCachedResult(analysisId) {
  try {
    const cachePath = path.join(CACHE_DIR, `${analysisId}.json`);
    const data = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return null; // File doesn't exist or other error
  }
}

/**
 * Cache an analysis result
 */
async function cacheResult(analysisId, result) {
  try {
    const cachePath = path.join(CACHE_DIR, `${analysisId}.json`);
    await fs.writeFile(cachePath, JSON.stringify(result), 'utf8');
  } catch (error) {
    console.error('Error caching result:', error);
  }
}

/**
 * Execute the full agent pipeline
 */
async function executeAgentPipeline(context) {
  // Step 1: Initial problem analysis
  await executeStep(context, 'problemAnalysis');
  
  // Step 2: Identify root causes
  await executeStep(context, 'rootCauseAnalysis');
  
  // Step 3: Generate solutions
  await executeStep(context, 'solutionGeneration');
  
  // Step 4: Validate solutions
  await executeStep(context, 'solutionValidation');
  
  // Step 5: Refine solutions
  await executeStep(context, 'solutionRefinement');
  
  // Step 6: Generate final response
  return await generateFinalResponse(context);
}

/**
 * Execute a single step of the agent pipeline
 */
async function executeStep(context, stepName) {
  console.log(`Executing step: ${stepName}`);
  
  const prompt = buildStepPrompt(context, stepName);
  const result = await callLLM(prompt, stepName);
  
  // Parse and store the result in context
  try {
    const parsedResult = JSON.parse(result);
    context.workingMemory[stepName] = parsedResult;
    context.analysisSteps.push({
      step: stepName,
      result: parsedResult
    });
    console.log(`Completed step: ${stepName}`);
    return parsedResult;
  } catch (error) {
    console.error(`Error parsing result for step ${stepName}:`, error);
    context.workingMemory[stepName] = { error: true, rawOutput: result };
    return { error: true };
  }
}

/**
 * Call the LLM with a prompt and get the result
 */
/**
 * Call the LLM with a prompt and get the result
 */
async function callLLM(prompt, stepName) {
    // Different steps might need different parameters
    const stepConfigs = {
      problemAnalysis: { temperature: 0.2, max_tokens: 1500 },
      rootCauseAnalysis: { temperature: 0.1, max_tokens: 2000 },
      solutionGeneration: { temperature: 0.7, max_tokens: 2500 },
      solutionValidation: { temperature: 0.1, max_tokens: 1500 },
      solutionRefinement: { temperature: 0.3, max_tokens: 2000 }
    };
    
    const config = stepConfigs[stepName] || { temperature: 0.5, max_tokens: 2000 };
    
    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: prompt }],
      temperature: config.temperature,
      max_tokens: config.max_tokens
    });
    
    const rawResponse = response.choices[0].message.content;
    
    // Clean the response to handle potential markdown code blocks
    let cleanResponse = rawResponse;
    
    // Remove markdown code blocks if present (```json...```)
    const codeBlockMatch = rawResponse.match(/```(?:json)?([\s\S]*?)```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
      cleanResponse = codeBlockMatch[1].trim();
    }
    
    // Remove any leading/trailing backticks and whitespace
    cleanResponse = cleanResponse.replace(/^`+|`+$/g, '').trim();
    
    return cleanResponse;
  }

/**
 * Build the prompt for a specific step of the analysis
 */
function buildStepPrompt(context, stepName) {
  // Base context information that's included in every prompt
  const baseContext = `
# CONVERSATION CONTEXT
${JSON.stringify(context.conversationHistory.slice(-3), null, 2)}

# TARGET BOT RESPONSE THAT NEEDS IMPROVEMENT
${JSON.stringify(context.targetBotResponse, null, 2)}

# USER FEEDBACK
${JSON.stringify(context.userFeedback, null, 2)}

# DC NODE PROMPT
${context.dc_node_prompt.substring(0, 500)}... (truncated for this step)

# CONFIGURED SKILLS
${JSON.stringify(context.configured_skills || [], null, 2)}

# SKILL EXECUTION STATUS
${context.skill_execution_status !== undefined ? `Skill ${context.skill_execution_status ? 'was' : 'was NOT'} executed.` : 'Status unknown.'}
`;

  // Previous steps' results to include
  let previousResults = '';
  for (const step of context.analysisSteps) {
    previousResults += `
# RESULTS FROM ${step.step.toUpperCase()}
${JSON.stringify(step.result, null, 2)}
`;
  }

  // Step-specific prompts
  const stepPrompts = {
    problemAnalysis: `
You are an AI assistant specialized in analyzing chatbot conversations and identifying problems.

${baseContext}

Your task is to carefully analyze the conversation and identify the specific problems with the bot's response.
Focus on identifying:
1. Did the bot fail to use the configured skills when it should have?
2. Did the bot produce an incorrect or unhelpful response?
3. Did the bot misunderstand the user's intent?
4. Did the bot miss important details or context?

OUTPUT FORMAT:
Return a JSON object with the following structure:
{
  "identified_problems": [
    {
      "problem_type": "string", // e.g., "skill_execution", "response_quality", "intent_understanding", etc.
      "description": "string", // Detailed description of the problem
      "evidence": "string" // Specific evidence from the conversation
    }
  ],
  "missing_information": [
    "string" // Any information you need but don't have
  ],
  "conversation_assessment": "string" // Overall assessment of the conversation
}`,

    rootCauseAnalysis: `
You are an AI assistant specialized in analyzing prompt designs and identifying root causes of chatbot failures.

${baseContext}

${previousResults}

Examine the DC node prompt and identified problems to determine the root causes.
Consider:
1. Is there ambiguity or contradiction in the instructions?
2. Are there missing instructions for handling this specific case?
3. Is there a token limit issue causing truncation?
4. Is there a formatting problem in how skills are referenced?

OUTPUT FORMAT:
Return a JSON object with the following structure:
{
  "root_causes": [
    {
      "cause_type": "string", // e.g., "ambiguous_instruction", "missing_instruction", "token_limit", etc.
      "description": "string", // Detailed description of the root cause
      "relevant_prompt_section": "string", // The specific section of the prompt causing issues
      "severity": "high|medium|low" // How serious this cause is
    }
  ],
  "prompt_assessment": "string" // Overall assessment of the current prompt design
}`,

    solutionGeneration: `
You are an AI assistant specialized in fixing chatbot prompts.

${baseContext}

${previousResults}

Based on the identified problems and root causes, generate specific solutions to fix the issues.
For each solution:
1. Provide the exact text to modify in the prompt
2. Provide the exact replacement text
3. Explain why this change will fix the issue

OUTPUT FORMAT:
Return a JSON object with the following structure:
{
  "solutions": [
    {
      "target": "string", // "dc_node_prompt" or "variable_prompt"
      "original_text": "string", // The text to be replaced
      "replacement_text": "string", // The new text
      "rationale": "string" // Why this change helps
    }
  ],
  "alternative_approaches": [
    {
      "description": "string", // Description of an alternative approach
      "pros": ["string"], // Advantages of this approach
      "cons": ["string"] // Disadvantages of this approach
    }
  ]
}`,

    solutionValidation: `
You are an AI assistant specialized in testing and validating chatbot prompt fixes.

${baseContext}

${previousResults}

Validate each proposed solution by considering:
1. Will it actually fix the identified problem?
2. Will it introduce new problems?
3. Is it consistent with the existing prompt?
4. Is it clear and unambiguous?

OUTPUT FORMAT:
Return a JSON object with the following structure:
{
  "validations": [
    {
      "solution_index": number, // Index of the solution being validated
      "is_valid": boolean, // Whether the solution is valid
      "reasoning": "string", // Why the solution is valid or invalid
      "suggested_improvements": "string" // How to improve the solution if needed
    }
  ],
  "overall_assessment": "string" // Overall assessment of the solutions
}`,

    solutionRefinement: `
You are an AI assistant specialized in refining chatbot prompt solutions.

${baseContext}

${previousResults}

Refine the proposed solutions based on the validation results:
1. Incorporate suggested improvements
2. Address any consistency issues
3. Ensure clarity and specificity
4. Make sure the solutions don't exceed token limits

OUTPUT FORMAT:
Return a JSON object with the following structure:
{
  "refined_solutions": [
    {
      "target": "string", // "dc_node_prompt" or "variable_prompt"
      "original_text": "string", // The text to be replaced
      "replacement_text": "string", // The refined new text
      "rationale": "string" // Why this refined solution is better
    }
  ],
  "implementation_priority": [
    {
      "solution_index": number, // Index of the refined solution
      "priority": "high|medium|low", // Priority for implementing this solution
      "reasoning": "string" // Why this priority level
    }
  ]
}`,
  };

  // Return the specific prompt for the requested step
  return stepPrompts[stepName] || "No prompt defined for this step.";
}

/**
 * Generate the final response based on all analysis steps
 */
async function generateFinalResponse(context) {
  const finalPrompt = `
You are an AI assistant specialized in summarizing chatbot prompt analysis and solutions.

# ANALYSIS STEPS COMPLETED
${JSON.stringify(context.analysisSteps, null, 2)}

Your task is to create a comprehensive final analysis report based on all the previous steps.
The report should be clear, actionable, and provide concrete solutions.

OUTPUT FORMAT:
Return a JSON object with the following structure:
{
  "issue_identified": "string", // Clear description of the identified issue
  "root_cause_analysis": "string", // Analysis of why the issue occurred
  "prompt_changes": {
    "modifications": [
      {
        "target": "string", // "dc_node_prompt" or "variable_prompt" or "model_configuration"
        "path": "string", // Location in the prompt
        "current": "string", // Text to replace
        "updated": "string", // New text
        "reasoning": "string" // Why this change helps
      }
    ]
  },
  "expected_impact": "string", // How these changes will improve the chatbot
  "risks_and_tradeoffs": "string", // Potential risks of making these changes
  "test_scenarios": [
    {
      "scenario": "string", // Test scenario description
      "user_input": "string", // Sample test input
      "expected_outcome": "string", // Expected bot behavior after changes
      "validation_criteria": "string" // How to verify success
    }
  ],
  "implementation_guide": {
    "priority": "high|medium|low",
    "difficulty": "easy|moderate|complex",
    "implementation_steps": [
      "string" // Step-by-step implementation instructions
    ]
  },
  "model_configuration_analysis": {
    "configuration_impact": "string",
    "recommended_configuration_changes": [
      {
        "parameter": "string",
        "current_value": "string",
        "recommended_value": "string",
        "rationale": "string"
      }
    ],
    "performance_limitations": [
      "string"
    ]
  },
  "confidence_score": "High|Medium|Low" // Confidence in the proposed solution
}`;

  const result = await callLLM(finalPrompt, 'finalResponse');
  
  // Parse the result
  try {
    const parsedResult = JSON.parse(result);
    return parsedResult;
  } catch (error) {
    console.error('Error parsing final response:', error);
    // Fallback to a simpler format if JSON parsing fails
    return {
      issue_identified: "Error generating structured analysis",
      raw_output: result,
      error: true,
      confidence_score: "Low"
    };
  }
}

/**
 * Calculate token count for a string
 * This is a simple approximation - production systems should use a proper tokenizer
 */
function estimateTokenCount(text) {
  // Rough approximation: 1 token ≈ 4 characters for English text
  return Math.ceil(text.length / 4);
}

/**
 * Check for conflicts between prompt sections
 */
function detectPromptConflicts(prompt) {
  // This would be a more sophisticated function in a production system
  // For now, we'll just look for some common patterns that might indicate conflicts
  
  const conflictPatterns = [
    { pattern: /never.*always/i, description: "Contradiction between 'never' and 'always'" },
    { pattern: /always.*never/i, description: "Contradiction between 'always' and 'never'" },
    { pattern: /must.*should not/i, description: "Contradiction between 'must' and 'should not'" },
    { pattern: /should not.*must/i, description: "Contradiction between 'should not' and 'must'" }
  ];
  
  const conflicts = [];
  
  for (const { pattern, description } of conflictPatterns) {
    if (pattern.test(prompt)) {
      conflicts.push({
        type: "potential_contradiction",
        description: description,
        severity: "medium"
      });
    }
  }
  
  return conflicts;
}

// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Agentic Prompt Debugger API running on port ${PORT}`);
});

module.exports = app;