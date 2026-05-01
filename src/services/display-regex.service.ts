import { evaluate, buildEnv, registry, resolveGroupCharacterNames } from "../macros";
import type { MacroEnv } from "../macros";
import * as chatsSvc from "./chats.service";
import * as charactersSvc from "./characters.service";
import * as personasSvc from "./personas.service";
import * as connectionsSvc from "./connections.service";
import { populateLumiaLoomContext } from "./prompt-assembly.service";
import { getEffectiveCharacterName } from "../types/character";
import type { Chat } from "../types/chat";
import type { RegexScript, RegexPlacement } from "../types/regex-script";

export interface ApplyDisplayRegexContext {
  chat_id?: string;
  character_id?: string;
  persona_id?: string;
  is_user: boolean;
  depth: number;
}

export interface ApplyDisplayRegexInput {
  content: string;
  scripts: RegexScript[];
  context: ApplyDisplayRegexContext;
  userId: string;
}

interface DisplayRegexMatch {
  fullMatch: string;
  groups: Array<string | undefined>;
  offset: number;
  namedGroups?: Record<string, string>;
}

const MACRO_TOKEN_RE = /\{\{|<USER>|<BOT>|<CHAR>/;

function hasMacroSyntax(value: string): boolean {
  return MACRO_TOKEN_RE.test(value);
}

function compileRegex(pattern: string, flags: string): RegExp | null {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}

function collectRegexMatches(input: string, regex: RegExp): DisplayRegexMatch[] {
  const matches: DisplayRegexMatch[] = [];
  input.replace(regex, (fullMatch, ...args) => {
    const last = args[args.length - 1];
    const hasNamedGroups = typeof last === "object" && last !== null;
    const namedGroups = hasNamedGroups ? (args.pop() as Record<string, string>) : undefined;
    args.pop() as string;
    const offset = args.pop() as number;
    const groups = args as Array<string | undefined>;
    matches.push({ fullMatch, groups, offset, namedGroups });
    return fullMatch;
  });
  return matches;
}

function substituteRegexCaptures(
  template: string,
  fullMatch: string,
  groups: Array<string | undefined>,
  offset: number,
  input: string,
  namedGroups?: Record<string, string>,
): string {
  return template.replace(/\$(?:(\$)|(&)|(`)|(')|(\d{1,2})|<([^>]*)>)/g,
    (token, dollar, amp, backtick, quote, digits, name) => {
      if (dollar !== undefined) return "$";
      if (amp !== undefined) return fullMatch;
      if (backtick !== undefined) return input.slice(0, offset);
      if (quote !== undefined) return input.slice(offset + fullMatch.length);
      if (digits !== undefined) {
        const idx = Number.parseInt(digits, 10);
        if (idx >= 1 && idx <= groups.length) return groups[idx - 1] ?? "";
        return token;
      }
      if (name !== undefined && namedGroups) return namedGroups[name] ?? token;
      return token;
    });
}

function rebuildFromMatches(input: string, matches: DisplayRegexMatch[], replacements: string[]): string {
  let output = "";
  let lastIndex = 0;
  for (let i = 0; i < matches.length; i += 1) {
    output += input.slice(lastIndex, matches[i].offset);
    output += replacements[i];
    lastIndex = matches[i].offset + matches[i].fullMatch.length;
  }
  output += input.slice(lastIndex);
  return output;
}

function buildEnvFromContext(userId: string, ctx: ApplyDisplayRegexContext): MacroEnv | null {
  if (ctx.chat_id) {
    const chat = chatsSvc.getChat(userId, ctx.chat_id);
    if (chat) {
      const messages = chatsSvc.getMessages(userId, ctx.chat_id);
      const character = charactersSvc.getCharacter(userId, chat.character_id);
      if (character) {
        const persona = personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id);
        const connection = connectionsSvc.getDefaultConnection(userId);
        const groupCharacterNames = resolveGroupCharacterNames(chat, (cid) => {
          const c = charactersSvc.getCharacter(userId, cid);
          return c ? getEffectiveCharacterName(c) : undefined;
        });
        const isGroup = !!chat.metadata?.group;
        const env = buildEnv({
          character,
          persona,
          chat,
          messages,
          generationType: "normal",
          connection,
          groupCharacterNames,
          targetCharacterName: isGroup ? getEffectiveCharacterName(character) : undefined,
        });
        populateLumiaLoomContext(env, userId, chat);
        return env;
      }
    }
  }
  if (ctx.character_id) {
    const character = charactersSvc.getCharacter(userId, ctx.character_id);
    if (character) {
      const persona = personasSvc.resolvePersonaOrDefault(userId, ctx.persona_id);
      const connection = connectionsSvc.getDefaultConnection(userId);
      const chat: Chat = {
        id: "",
        character_id: character.id,
        name: "",
        metadata: {},
        created_at: 0,
        updated_at: 0,
      };
      const env = buildEnv({
        character,
        persona,
        chat,
        messages: [],
        generationType: "normal",
        connection,
      });
      populateLumiaLoomContext(env, userId, chat);
      return env;
    }
  }
  return null;
}

export async function applyDisplayRegex(input: ApplyDisplayRegexInput): Promise<string> {
  const { content, scripts, context, userId } = input;
  let result = content;

  let env: MacroEnv | null = null;
  let envBuilt = false;
  const ensureEnv = (): MacroEnv | null => {
    if (!envBuilt) {
      env = buildEnvFromContext(userId, context);
      envBuilt = true;
    }
    return env;
  };

  for (const script of scripts) {
    const placement: RegexPlacement = context.is_user ? "user_input" : "ai_output";
    if (!script.placement.includes(placement)) continue;
    if (script.min_depth !== null && context.depth < script.min_depth) continue;
    if (script.max_depth !== null && context.depth > script.max_depth) continue;

    let findRegex = script.find_regex;
    if (script.substitute_macros !== "none" && hasMacroSyntax(findRegex)) {
      const e = ensureEnv();
      if (e) {
        const r = await evaluate(findRegex, e, registry);
        findRegex = r.text;
      }
    }
    const regex = compileRegex(findRegex, script.flags);
    if (!regex) continue;

    try {
      if (script.substitute_macros === "raw") {
        const matches = collectRegexMatches(result, regex);
        if (matches.length > 0) {
          const replacements: string[] = [];
          for (const m of matches) {
            const withCaptures = substituteRegexCaptures(
              script.replace_string, m.fullMatch, m.groups, m.offset, result, m.namedGroups,
            );
            if (hasMacroSyntax(withCaptures)) {
              const e = ensureEnv();
              if (e) {
                const r = await evaluate(withCaptures, e, registry);
                replacements.push(r.text);
              } else {
                replacements.push(withCaptures);
              }
            } else {
              replacements.push(withCaptures);
            }
          }
          result = rebuildFromMatches(result, matches, replacements);
        }
      } else {
        let replaceString = script.replace_string;
        if (script.substitute_macros !== "none" && hasMacroSyntax(replaceString)) {
          const e = ensureEnv();
          if (e) {
            const r = await evaluate(replaceString, e, registry);
            replaceString = r.text;
          }
          if (script.substitute_macros === "escaped") {
            replaceString = replaceString.replace(/\$/g, "$$$$");
          }
        }
        result = result.replace(regex, replaceString);
      }

      for (const trim of script.trim_strings) {
        while (result.includes(trim)) {
          result = result.replaceAll(trim, "");
        }
      }
    } catch {
      continue;
    }
  }

  return result;
}
