import{dt as e,ut as t}from"./global-Cs_teJJq.js";import{Yt as n,gr as r,hr as i,mr as a,t as o}from"./store-CwKsWFRu.js";var s=`You are a Lucid Loom narrative archivist for interactive fiction and roleplay. Your task is to weave comprehensive story summaries that maintain narrative continuity while capturing the essence of the tale.

Your summary MUST use this exact structured format with clear headers:

**Completed Objectives** (MAX 7 items)
Story beats and arcs that have already concluded. Plot points resolved, conflicts addressed, milestones reached.

**Focused Objectives** (MAX 5 items)
Active story threads requiring attention. These can shift or be deviated from at any time but represent current narrative focus.

**Foreshadowing Beats** (MAX 5 items)
Events hinted at or seeded in recent story beats. Potential future complications, promises made, warnings given.

**Character Developments** (MAX 7 items total)
Track meaningful changes in personality, beliefs, skills, or emotional state for each character (NEVER {{user}}).

**Memorable Actions** (MAX 7 items)
Physical actions of significance—combat moves, gestures, gifts exchanged, locations visited. Details that may matter later.

**Memorable Dialogues** (MAX 5 items)
Words that left a mark. Confessions, promises, threats, revelations, or simply beautiful turns of phrase.

**Relationships** (MAX 5 items)
{{relationshipGuidance}}

CRITICAL GUIDELINES:
- Use bullet points under each header for clarity—avoid walls of text
- Be precise and detailed, never sacrifice important information
- Be concise, never pad with redundant or obvious observations
- If a category has no relevant content, write "None at present" rather than inventing filler
- NEVER track or summarize {{user}}'s thoughts, feelings, or internal state
- RESPECT ITEM LIMITS: Each category has a maximum item count. When at capacity, remove the oldest or least relevant item to make room for new ones
- PRESERVE IMPORTANT HISTORY: When removing items, prioritize keeping entries that have ongoing narrative relevance (active plot threads, unresolved tensions, recurring themes)
- CONSOLIDATE when possible: Combine related items into single, more comprehensive bullet points rather than having many fragmented entries`,c=`{{previousSummaryBlock}}**RECENT STORY EVENTS** to weave into the summary:

{{conversation}}

Provide an updated Loom Summary incorporating these new events. Use the exact structured format with all seven headers. Output ONLY the summary content—no meta-commentary or additional formatting.`,l=[{token:`{{user}}`,description:`Active persona / user name`},{token:`{{char}}`,description:`Active character name (or first group member)`},{token:`{{groupMembers}}`,description:`Comma-separated group member names`},{token:`{{relationshipGuidance}}`,description:`Pre-composed relationship-tracking sentence`}],u=[{token:`{{user}}`,description:`Active persona / user name`},{token:`{{char}}`,description:`Active character name (or first group member)`},{token:`{{previousSummaryBlock}}`,description:`Full "PREVIOUS LOOM SUMMARY" merge block (empty when none)`},{token:`{{existingSummary}}`,description:`Raw previous summary text (empty when none)`},{token:`{{conversation}}`,description:`Formatted "Name: message" transcript`}];function d(e){let t=typeof e==`number`?e:Number(e);return Number.isFinite(t)?Math.max(0,Math.floor(t)):0}function f(e,t){return Math.max(0,(Number.isFinite(e)?Math.max(0,Math.floor(e)):0)-d(t))}function p(e,t,n,r=0){let i=f(e,r),a=Number.isFinite(t)?Math.max(0,Math.floor(t)):0,o=Number.isFinite(n)?Math.max(1,Math.floor(n)):1;return i>=o&&i-a>=o}var m=null,h=null;async function g(){return m||h||(h=n.getSummarizationDefaults().then(e=>(m=e,e)).catch(e=>{console.warn(`[summary] Falling back to bundled defaults:`,e);let t={systemPrompt:s,userPrompt:c};return m=t,t}).finally(()=>{h=null}),h)}var _=5e3;function v(e){let t=typeof e==`number`?e:Number(e);return Number.isFinite(t)?Math.max(_,Math.round(t)):a}async function y(a){let{chatId:s,connectionId:c,messageContext:l,messageLag:u,userName:p,characterName:m,systemPromptOverride:h,userPromptOverride:g,requestTimeoutMs:_}=a,y=(await t.get(s)).metadata?.loom_summary||``,b=await e.list(s,{limit:1}),x=d(u),S=await n.summarize({chat_id:s,message_context:l,message_lag:x,existingSummary:y,userName:p,characterName:m,systemPromptOverride:h,userPromptOverride:g,connection_id:c},{timeout:v(_)}),C=S.content?.trim();if(!C)throw S.reasoning?Error(`Model returned only reasoning with no summary content`):Error(`No summary generated (finish reason: ${S.finish_reason||`unknown`})`);return await t.patchMetadata(s,{[r]:C,[i]:{messageCount:f(b.total,x),timestamp:Date.now()}}),o.getState().setLastSummaryMutation({chatId:s,summaryText:C}),C}async function b(e,n){let i=n.trim();await t.patchMetadata(e,{[r]:i||null}),o.getState().setLastSummaryMutation({chatId:e,summaryText:i})}async function x(e){await t.patchMetadata(e,{[r]:null,[i]:null}),o.getState().setLastSummaryMutation({chatId:e,summaryText:``})}async function S(e){return(await t.get(e)).metadata?.loom_summary||``}async function C(e){return(await t.get(e)).metadata?.loom_last_summarized_at||null}export{g as a,s as c,u as d,S as i,c as l,y as n,b as o,C as r,p as s,x as t,l as u};