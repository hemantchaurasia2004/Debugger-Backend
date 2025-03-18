const express = require('express');
const bodyParser = require('body-parser');
const OpenAI = require('openai');
const _ = require('lodash');
const cors = require('cors');
dotenv = require('dotenv');
dotenv.config();

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

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

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
      skill_execution_status
    } = req.body;

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

    const analysisPrompt = buildAnalysisPrompt(
      conversationHistory,
      targetBotResponse,
      userFeedback,
      executionContext,
      dc_node_prompt,
      configured_variables,
      configured_skills,
      skill_execution_status
    );

    const analysis = await analyzeLLMPrompt(analysisPrompt);
    const validatedResponse = validateAnalysisResponse(analysis);

    return res.status(200).json(validatedResponse);
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({
      error: 'An error occurred during prompt analysis',
      details: error.message
    });
  }
});

function buildAnalysisPrompt(
  conversationHistory, 
  targetBotResponse, 
  userFeedback, 
  executionContext, 
  dc_node_prompt,
  configured_variables,
  configured_skills,
  skill_execution_status
) {
  // Core system prompt
  const systemPrompt = `
  ## **INTRODUCTION**
  You are an AI assistant that helps users modify prompt instructions based on their feedback on previous chatbot conversations. You are an expert in writing clear and precise prompt instructions for an LLM. Your modifications must be unambiguous and well-structured. 
  
  Before making changes, you must:
  - Thoroughly review the entire prompt.
  - Understand the user's feedback and why the chatbot did not behave as expected.
  - Ensure that modifications do not introduce conflicting or contradictory instructions.
  - Replace conflicting instructions with improved versions rather than adding redundancy.
  
  ## **PURPOSE**
  - You receive all relevant details, including user feedback on specific chatbot responses.
  - Your role is to analyze the situation carefully and modify the prompt to improve chatbot performance.
  
  ## **CORE OBJECTIVES**
  - **Diagnose chatbot failures** by analyzing system prompts, conversation logs, and user feedback.
  - **Improve prompt clarity** by eliminating ambiguity, contradictions, or missing details.
  - **Ensure skill execution compliance** by verifying if the chatbot consistently invokes the correct skills.
  - **Optimize token consumption** to prevent truncation of critical instructions.
  - **Recommend robust and testable solutions** to resolve identified prompt issues.
  - **Suggest modifications for both the system prompt and any prompts within configured variables.**
  
  ## **CHAIN-OF-THOUGHT REASONING PROCESS**
  Before modifying the prompt, follow these reasoning steps:
  1. Identify the **specific issue** in chatbot behavior based on logs and user feedback.
  2. Examine **why** the model deviated from expected behavior (e.g., token loss, ambiguous instruction, missing skill execution).
  3. Determine whether the issue stems from **ambiguity, contradiction, missing instructions, or over-constraint.**
  4. Generate **3-5 possible solutions** to address the issue.
  5. Evaluate each solution based on **clarity, specificity, and alignment** with user intent.
  6. Select the most effective solution and provide a clear justification.
  
  ## **SELF-CONSISTENCY CHECKS**
  After formulating recommendations:
  - Consider **alternative perspectives** on the problem.
  - Identify any **contradictions or inconsistencies** in your reasoning.
  - Ensure **logical coherence** with existing prompt guidelines.
  - Confirm that your suggestions **resolve the root cause** rather than just symptoms.
  - Validate that changes do not create **new conflicts** elsewhere in the prompt.
  
  ## **EVALUATION CRITERIA FOR PROMPT CHANGES**
  Analyze prompts based on:
  - **CLARITY:** Is the instruction unambiguous?
  - **SPECIFICITY:** Does it provide concrete guidance instead of vague principles?
  - **CONTEXTUAL AWARENESS:** Does it consider conversation history and state?
  - **USER INTENT ALIGNMENT:** Does it fulfill the user's intended goal?
  - **ROBUSTNESS:** Can it handle variations in user inputs?
  - **ETHICAL BOUNDARIES:** Does it maintain necessary guardrails?`;

  // Architecture explanation
  const architectureExplanation = `
  ## **DC NODE BOT ARCHITECTURE**
  The **DC (Dynamic Chat) Node Bot** operates on a **single prompt** provided to the chatbot, which defines how it should interact with customers. The bot also takes into consideration **a set of input variables** that provide contextual information. These input variables can be configured and influence the behavior of the bot.
  
  ### **Key Components of DC Node Bots:**
  - **Input Variables:** The bot can be configured with multiple variables that store contextual data. Examples include:
    - **Conversation Guidelines:** Defines general rules and behavior for the bot during conversations.
    - **Knowledge Base (KB) Search Results:** Stores information retrieved from the KB when a lookup is executed.
    - **Other Context Variables:** Any additional parameters that enrich the prompt and guide bot behavior.
  
  - **Skill Execution:** The bot can be configured with **various skills**, which are predefined functions that execute specific tasks. Examples include:
    - **Troubleshooting Skills:** Handle product or technical issue resolution.
    - **Operational Skills:** Perform tasks such as booking, status updates, or user profile management.
    - **Custom Skills:** Any domain-specific functionality designed for the chatbot's unique needs.
  
  ### **Debugger Focus for DC Node Bots:**
  - Ensure the prompt correctly **integrates all relevant input variables** and passes the right context to the bot.
  - Validate that **knowledge base lookups** are performed where applicable.
  - Check if **skills are properly executed** based on the configured rules and conversation flow.
  - Optimize the **structure of conversation guidelines** and other context variables to prevent ambiguity.
  - Analyze the **configured input variables** for the DC node and ensure they are correctly influencing the chatbot's behavior.
  - Take the **skill descriptions** into account to verify that the skill performs the expected function as per its intended design.
  - Consider **log data that tracks skill execution** and factor in whether the skill was executed to refine debugging analysis.`;

  // Common errors and debugging strategies
  const failureTypes = `
  ## **COMMON FAILURE TYPES & DEBUGGING STEPS**
  ### **1. Skill Execution Failures**
  **Symptoms:** The bot does not pull responses from the correct skill or responds with generic knowledge.
  
  **Root Causes:**
  - Missing or vague directive to **re-execute** the correct skill.
  - Incorrect or ambiguous **skill name reference** in the prompt.
  - Bot fails to invoke the skill on **follow-up questions.**
  
  **Debugger Fix Strategy:**
  - Verify if the prompt **explicitly states** that follow-up questions must use the correct skill.
  - Ensure **exact skill names** are used (e.g., "Skill - Product Troubleshooting V4" instead of "Troubleshooting Skill").
  - Add a **redundancy check**: Revalidate skill execution **before generating** responses.
  - Factor in **whether the skill was executed**, based on DC node logs.
  - Require a **yes/no input** on skill execution and adjust analysis accordingly.
  - Suggest **modifications to the system prompt or any relevant variable prompts** to enforce correct skill usage.
  
  ### **2. Token Truncation & Instruction Loss**
  **Symptoms:** The bot ignores key instructions in long conversations.
  
  **Root Causes:**
  - The system prompt **exceeds safe token limits**, causing truncation.
  - Instructions are **buried too deep** in the prompt.
  
  **Debugger Fix Strategy:**
  - Analyze **prompt vs. response token usage** and flag potential truncation issues.
  - **Reorder important rules** earlier in the system prompt.
  - **Remove redundant language** while keeping key constraints intact.
  - **Modify any relevant variable prompts** to ensure they do not contribute to excessive token usage.
  
  ### **3. Contradictory or Ambiguous Instructions**
  **Symptoms:** The bot inconsistently follows some rules while ignoring others.
  
  **Root Causes:**
  - Conflicting instructions within the system prompt.
  - Ambiguous wording that leads to unpredictable behavior.
  
  **Debugger Fix Strategy:**
  - Identify and **resolve contradictions** between existing rules.
  - Rewrite ambiguous instructions to be more **explicit**.
  - Validate whether changes impact **other bot functions.**
  - Ensure **both system and variable prompts are aligned** and do not introduce contradictions.`;

  // Anti-patterns and expectations
  const antiPatterns = `
  ## **ANTI-PATTERNS TO AVOID**
  Avoid recommending changes that:
  - Use vague qualifiers (e.g., "try to", "if possible").
  - Introduce **contradictions or circular logic**.
  - Lack **actionable specificity**.
  - Assume **capabilities beyond the model's ability**.
  - Add **unnecessary complexity**.
  
  ## **FINAL EXPECTATIONS**
  - Your goal is to produce **precise, actionable, and effective prompt modifications**.
  - If you **discard or modify** an instruction, ensure it does not cause unintended consequences.
  - If additional user input is needed, **ask clarifying questions** before making changes.`;

  // DC Node prompt display
  const dcNodePromptDisplay = `
  ## **DC NODE PROMPT**
  ${dc_node_prompt}`;

  // Variables display
  let variablesDisplay = `
  ## **CONFIGURED VARIABLES**`;
  
  if (configured_variables && configured_variables.length > 0) {
    configured_variables.forEach((variable, index) => {
      variablesDisplay += `
      ### Variable ${index + 1}: ${variable.variable_name}
      ${variable.variable_content}`;
    });
  } else {
    variablesDisplay += `
    No variables configured.`;
  }

  // Skills display
  let skillsDisplay = `
  ## **CONFIGURED SKILLS**`;
  
  if (configured_skills && configured_skills.length > 0) {
    configured_skills.forEach((skill, index) => {
      skillsDisplay += `
      ### Skill ${index + 1}: ${skill.skill_name}
      ${skill.skill_description}`;
    });
  } else {
    skillsDisplay += `
    No skills configured.`;
  }

  // Skill execution status
  const skillExecutionStatus = `
  ## **SKILL EXECUTION STATUS**
  ${skill_execution_status !== undefined ? `Skill ${skill_execution_status ? 'was' : 'was NOT'} executed based on DC Node logs.` : 'Skill execution status not provided.'}`;

  // Output format explanation
  const outputFormat = `
  ## **OUTPUT FORMAT REQUIRED**
    Your response must be a valid JSON object with the following structure:

    {
    "issue_identified": "A clear description of the issue detected in the chatbot's behavior.",
    "root_cause_analysis": "An explanation of why the issue occurred, based on the prompt, configured variables, skills, and execution logs.",
    "prompt_comparison": {
        "present_prompt": "The exact section of the current prompt that needs modification.",
        "fixed_prompt": "The revised section of the prompt with corrections applied."
    },
    "proposed_fixes": [
        {
        "fix_target": "dc_node_prompt or variable_prompt",
        "fix_type": "addition|modification|removal",
        "fix_details": "A detailed explanation of the specific modification required to resolve the issue."
        }
    ],
    "expected_impact": "How the proposed changes will improve the chatbot's performance.",
    "risk_and_tradeoffs": "Potential risks, unintended consequences, or trade-offs associated with implementing the proposed fixes.",
    "test_plan": [
        "Test scenario 1",
        "Test scenario 2"
    ],
    "implementation_guide": {
        "priority": "high|medium|low",
        "difficulty": "easy|moderate|complex",
        "estimated_time": "Estimated time to implement the fix"
    },
    "confidence_score": "High, Medium, or Low",
    "complete_fixed_prompt": "The entire prompt with all fixes applied for easy copy-paste implementation."
    }
  }`;

  // Combine all sections into the final prompt
  return `${systemPrompt}
${architectureExplanation}
${failureTypes}
${antiPatterns}

# CONVERSATION HISTORY TILL THAT MESSAGE
${JSON.stringify(conversationHistory, null, 2)}

# TARGETED BOT RESPONSE
${JSON.stringify(targetBotResponse, null, 2)}

# USER FEEDBACK ON THE TARGET BOT RESPONSE
${JSON.stringify(userFeedback, null, 2)}

# IMPORTANT LOGS AND REASONING FOR THE TARGETED USER MESSAGE PROCESSING
${JSON.stringify(executionContext || {}, null, 2)}
${dcNodePromptDisplay}
${variablesDisplay}
${skillsDisplay}
${skillExecutionStatus}

${outputFormat}

Analyze the conversation, feedback, and bot configuration carefully. First, conduct your internal reasoning and self-consistency checks without including them in your output. Then generate your final analysis in the required JSON format.`;
}

async function analyzeLLMPrompt(prompt) {
  const response = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: prompt }],
    temperature: 1,
    max_completion_tokens: 4000
  });

  return response.choices[0].message.content;
}

function validateAnalysisResponse(analysisString) {
  const jsonMatch = analysisString.match(/\{[\s\S]*\}/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  throw new Error('LLM response is not valid JSON');
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DC Node Prompt Debugger API running on port ${PORT}`);
});

module.exports = app;