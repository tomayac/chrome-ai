import {
  LanguageModelV1,
  LanguageModelV1CallOptions,
  LanguageModelV1CallWarning,
  LanguageModelV1FinishReason,
  LanguageModelV1FunctionToolCall,
  LanguageModelV1ImagePart,
  LanguageModelV1LogProbs,
  LanguageModelV1Prompt,
  LanguageModelV1StreamPart,
  LanguageModelV1TextPart,
  LanguageModelV1ToolCallPart,
  LanguageModelV1ToolResultPart,
  LoadSettingError,
  UnsupportedFunctionalityError,
} from '@ai-sdk/provider';
import type {
  ChromeAIAssistant,
  ChromeAIAssistantCreateOptions,
} from './global';
import { ChromeAICapabilityAvailability } from './enum';
import createDebug from 'debug';
import { objectStartSequence, objectStopSequence, StreamAI } from './stream-ai';

const debug = createDebug('chromeai');

export type ChromeAIChatModelId = 'text';

export interface ChromeAIChatSettings extends ChromeAIAssistantCreateOptions {}

function getStringContent(
  content:
    | string
    | (LanguageModelV1TextPart | LanguageModelV1ImagePart)[]
    | (LanguageModelV1TextPart | LanguageModelV1ToolCallPart)[]
    | LanguageModelV1ToolResultPart[]
): string {
  if (typeof content === 'string') {
    return content.trim();
  } else if (Array.isArray(content) && content.length > 0) {
    const [first] = content;
    if (first.type !== 'text') {
      throw new UnsupportedFunctionalityError({ functionality: 'toolCall' });
    }
    return first.text.trim();
  } else {
    return '';
  }
}

export class ChromeAIChatLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1';
  readonly defaultObjectGenerationMode = 'json';
  readonly modelId: ChromeAIChatModelId = 'text';
  readonly provider = 'gemini-nano';
  readonly supportsImageUrls = false;
  readonly supportsStructuredOutputs = false;

  options: ChromeAIChatSettings;

  constructor(
    modelId: ChromeAIChatModelId,
    options: ChromeAIChatSettings = {}
  ) {
    this.modelId = modelId;
    this.options = options;
    debug('init:', this.modelId);
  }

  private session!: ChromeAIAssistant;
  private getSession = async (
    options?: ChromeAIAssistantCreateOptions
  ): Promise<ChromeAIAssistant> => {
    if (!globalThis.ai?.languageModel) {
      throw new LoadSettingError({ message: 'Browser not support' });
    }
    if (this.session) return this.session;

    const cap = await ai.languageModel.capabilities();

    if (cap.available !== ChromeAICapabilityAvailability.READILY) {
      throw new LoadSettingError({ message: 'Built-in model not ready' });
    }

    this.options = {
      temperature: cap.defaultTemperature,
      topK: cap.defaultTopK,
      ...this.options,
      ...options,
    };

    this.session = await ai.languageModel.create(this.options);

    debug('session created:', this.session, this.options);
    return this.session;
  };

  private formatMessages = (options: LanguageModelV1CallOptions): string => {
    let prompt: LanguageModelV1Prompt = options.prompt;
    debug('before format prompt:', prompt);

    let result = '';

    if (
      // When the user supplied a prompt input, we don't transform it
      options.inputFormat === 'prompt' &&
      prompt.length === 1 &&
      prompt[0].role === 'user' &&
      prompt[0].content.length === 1 &&
      prompt[0].content[0].type === 'text'
    ) {
      result += prompt[0].content[0].text;
    } else {
      // Use magic prompt for object-json mode
      if (options.mode.type === 'object-json') {
        prompt.unshift({
          role: 'system',
          content: `Throughout our conversation, always start your responses with "{" and end with "}", ensuring the output is a concise JSON object and strictly avoid including any comments, notes, explanations, or examples in your output.\nFor instance, if the JSON schema is {"type":"object","properties":{"someKey":{"type":"string"}},"required":["someKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}, your response should immediately begin with "{" and strictly end with "}", following the format: {"someKey": "someValue"}.\nAdhere to this format for all queries moving forward.`,
        });
      }

      for (let index = 0; index < prompt.length; index += 1) {
        const { role, content } = prompt[index];
        const contentString = getStringContent(content);

        switch (role) {
          case 'system':
            result += `${contentString}\n`;
            break;
          case 'assistant':
          case 'tool':
            result += `model\n${contentString}\n`;
            break;
          case 'user':
          default:
            result += `user\n${contentString}\n`;
            break;
        }
      }
      result += `model\n`;
    }

    debug('formated message:', result);
    return result;
  };

  public doGenerate = async (
    options: LanguageModelV1CallOptions
  ): Promise<{
    text?: string;
    toolCalls?: LanguageModelV1FunctionToolCall[];
    finishReason: LanguageModelV1FinishReason;
    usage: { promptTokens: number; completionTokens: number };
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
    rawResponse?: { headers?: Record<string, string> };
    warnings?: LanguageModelV1CallWarning[];
    logprobs?: LanguageModelV1LogProbs;
  }> => {
    debug('generate options:', options);

    if (['regular', 'object-json'].indexOf(options.mode.type) < 0) {
      throw new UnsupportedFunctionalityError({
        functionality: `${options.mode.type} mode`,
      });
    }

    const session = await this.getSession();
    const message = this.formatMessages(options);
    let text = await session.prompt(message);

    if (options.mode.type === 'object-json') {
      text = text.replace(new RegExp('^' + objectStartSequence, 'ig'), '');
      text = text.replace(new RegExp(objectStopSequence + '$', 'ig'), '');
    }

    debug('generate result:', text);

    return {
      text,
      finishReason: 'stop',
      usage: { promptTokens: 0, completionTokens: 0 },
      rawCall: { rawPrompt: options.prompt, rawSettings: this.options },
    };
  };

  public doStream = async (
    options: LanguageModelV1CallOptions
  ): Promise<{
    stream: ReadableStream<LanguageModelV1StreamPart>;
    rawCall: { rawPrompt: unknown; rawSettings: Record<string, unknown> };
    rawResponse?: { headers?: Record<string, string> };
    warnings?: LanguageModelV1CallWarning[];
  }> => {
    debug('stream options:', options);

    if (['regular', 'object-json'].indexOf(options.mode.type) < 0) {
      throw new UnsupportedFunctionalityError({
        functionality: `${options.mode.type} mode`,
      });
    }

    const session = await this.getSession();
    const message = this.formatMessages(options);
    const promptStream = session.promptStreaming(message);
    const transformStream = new StreamAI(options);
    const stream = promptStream.pipeThrough(transformStream);

    return {
      stream,
      rawCall: { rawPrompt: options.prompt, rawSettings: this.options },
    };
  };
}
