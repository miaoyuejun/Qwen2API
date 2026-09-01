const { generateUUID } = require('./tools.js');
const { logger } = require('./logger');

// 内嵌 Agent 控制标签常量，避免引用缺失的 agent-turn.js
const AGENT_FINAL_OPEN = '<agent_final>';
const AGENT_FINAL_CLOSE = '</agent_final>';
const AGENT_BLOCKED_OPEN = '<agent_blocked>';
const AGENT_BLOCKED_CLOSE = '</agent_blocked>';
const TOOL_CALL_OPEN = '[TOOL CALL]';
const TOOL_CALL_CLOSE = '[END TOOL CALL]';

const TOOL_RESULT_OPEN = '[TOOL RESULT: ';
const TOOL_RESULT_CLOSE = '[END TOOL RESULT]';

const TOOL_CALL_TRIGGER_RE = /<[ \t]{0,4}tool_calls?|\[[ \t]{0,4}tool[ \t_-]{1,2}calls?/i;
const TOOL_CALL_PAYLOAD_WINDOW = 128;
const TOOL_CALL_TRIGGER_MAX = Math.max(
  '<    tool_calls'.length,
  '[    tool  calls'.length
);

const TOOL_CALL_CLOSE_RE =
  /^<[ \t]{0,4}\/[ \t]{0,4}tool_calls?[^\s<>＞]{0,16}[ \t\r\n]{0,4}(?:[A-Za-z_][\w-]{0,15})?[ \t\r\n]{0,4}[>＞]/i;
const TOOL_CALL_CLOSE_BARE_RE = /^<[ \t]{0,4}\/[ \t]{0,4}tool_calls?/i;

const TOOL_CALL_CLOSE_BRACKET_RE =
  /^\[[ \t]{0,4}(?:END[ \t_-]{1,2}|\/[ \t]{0,4})TOOL[ \t_-]{1,2}CALLs?[^\s[\]]{0,16}[ \t\r\n]{0,4}\]/i;
const TOOL_CALL_CLOSE_BRACKET_BARE_RE =
  /^\[[ \t]{0,4}(?:END[ \t_-]{1,2}|\/[ \t]{0,4})TOOL[ \t_-]{1,2}CALLs?/i;

const TOOL_CALL_CLOSE_MAX = Math.max(
  '</    tool_calls'.length + 42,
  '[    END  TOOL  CALLS'.length + 42
);

const TOOL_CALL_SPAN_MAX = 1024 * 1024;

const LEAKED_PAYLOAD_NAME_RE = /"name"\s*:/;
const LEAKED_PAYLOAD_ARGS_RE = /"arguments"\s*:/;
const LEAKED_PAYLOAD_NAME_WINDOW = 256;
const isLeakedToolPayloadShape = (value) => {
  const trimmed = String(value || '').trimStart();
  if (!trimmed.startsWith('{')) return false;
  const object = extractBalancedObject(trimmed, 0);
  const scope = object ? object.text : trimmed;
  return LEAKED_PAYLOAD_NAME_RE.test(scope.slice(0, LEAKED_PAYLOAD_NAME_WINDOW)) &&
    LEAKED_PAYLOAD_ARGS_RE.test(scope);
};

const createCodeContextTracker = () => {
  let inFence = false;
  let ticksOnLine = 0;
  let run = 0;
  let runAtLineStart = true;
  let lineIsBlank = true;

  const settle = () => {
    if (run === 0) return;
    if (run >= 3 && runAtLineStart) {
      inFence = !inFence;
      ticksOnLine = 0;
    } else if (!inFence) {
      ticksOnLine += run;
    }
    run = 0;
  };

  return {
    consume: (text) => {
      for (let i = 0; i < text.length; i += 1) {
        const char = text[i];
        if (char === '`') {
          if (run === 0) runAtLineStart = lineIsBlank;
          run += 1;
          lineIsBlank = false;
          continue;
        }
        settle();
        if (char === '\n') {
          ticksOnLine = 0;
          lineIsBlank = true;
        } else if (char !== ' ' && char !== '\t' && char !== '\r') {
          lineIsBlank = false;
        }
      }
    },
    inCode: () => {
      const fenceToggles = run >= 3 && (run === 0 ? lineIsBlank : runAtLineStart);
      const fence = fenceToggles ? !inFence : inFence;
      if (fence) return true;
      const ticks = fenceToggles ? 0 : ticksOnLine + run;
      return ticks % 2 === 1;
    }
  };
};

const extractBalancedObject = (text, start) => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { text: text.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
};

const isMarkdownLinkTail = (triggerText, tail) =>
  triggerText.charAt(0) === '[' && /\]\(/.test(tail);

const findPayloadStart = (text, from, canGrow) => {
  const limit = Math.min(text.length, from + TOOL_CALL_PAYLOAD_WINDOW);
  for (let i = from; i < limit; i += 1) {
    if (text[i] === '{') return i;
  }
  if (canGrow && text.length - from < TOOL_CALL_PAYLOAD_WINDOW) return -2;
  return -1;
};

const matchToolCallOpening = (text, { emittedProse = false, canSalvage = false } = {}) => {
  const match = text.match(TOOL_CALL_TRIGGER_RE);
  if (canSalvage && !emittedProse) {
    const braceAt = text.search(/\S/);
    if (braceAt !== -1 && text[braceAt] === '{' &&
        (!match || braceAt < match.index) &&
        isLeakedToolPayloadShape(text)) {
      return { index: braceAt, text: '', synthetic: true };
    }
  }
  if (match) return { index: match.index, text: match[0], synthetic: false };
  return null;
};

const skipTrailingFence = (text, from, tail, canGrow) => {
  if (!tail.includes('```')) return { end: from, needMore: false };
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return { end: from, needMore: !!canGrow };
  if (text[index] !== '`') return { end: from, needMore: false };
  let ticks = 0;
  while (index + ticks < text.length && text[index + ticks] === '`') ticks += 1;
  if (ticks < 3) {
    if (canGrow && index + ticks >= text.length) return { end: from, needMore: true };
    return { end: from, needMore: false };
  }
  return { end: index + ticks, needMore: false };
};

const consumeTrailingCloser = (text, from, canGrow) => {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return { end: from, needMore: !!canGrow };
  const head = text[index];
  if (head !== '<' && head !== '[') return { end: from, needMore: false };
  const slice = text.slice(index, index + TOOL_CALL_CLOSE_MAX);
  const match = slice.match(head === '<' ? TOOL_CALL_CLOSE_RE : TOOL_CALL_CLOSE_BRACKET_RE);
  if (match) return { end: index + match[0].length, needMore: false };
  const terminator = head === '<'
    ? (!slice.includes('>') && !slice.includes('＞') && !slice.includes('<', 1))
    : (!slice.includes(']') && !slice.includes('[', 1));
  if (canGrow && slice.length < TOOL_CALL_CLOSE_MAX && terminator) {
    return { end: from, needMore: true };
  }
  const bare = slice.match(head === '<' ? TOOL_CALL_CLOSE_BARE_RE : TOOL_CALL_CLOSE_BRACKET_BARE_RE);
  if (!canGrow && bare && !slice.slice(bare[0].length).trim()) {
    return { end: index + slice.length, needMore: false };
  }
  return { end: from, needMore: false };
};

const consumeMandatoryBracketCloser = (text, from, canGrow) => {
  let index = from;
  while (index < text.length && /\s/.test(text[index])) index += 1;
  if (index >= text.length) return { end: from, needMore: !!canGrow, found: false };
  if (text[index] !== '[') return { end: from, needMore: false, found: false };
  const slice = text.slice(index, index + TOOL_CALL_CLOSE_MAX);
  const match = slice.match(TOOL_CALL_CLOSE_BRACKET_RE);
  if (match) return { end: index + match[0].length, needMore: false, found: true };
  const viable = !slice.includes(']') && !slice.includes('[', 1);
  if (canGrow && slice.length < TOOL_CALL_CLOSE_MAX && viable) {
    return { end: from, needMore: true, found: false };
  }
  const bare = slice.match(TOOL_CALL_CLOSE_BRACKET_BARE_RE);
  if (!canGrow && bare && !text.slice(index + bare[0].length).trim()) {
    return { end: text.length, needMore: false, found: true };
  }
  return { end: from, needMore: false, found: false };
};

const CLOSER_PREFIX_LITERALS = [
  'END TOOL CALLS', 'END_TOOL_CALLS', 'END-TOOL-CALLS',
  '/TOOL CALLS', '/TOOL_CALLS', '/TOOL-CALLS'
];
const isDanglingCloserPrefix = (value) => {
  const match = value.match(/^([[<])[ \t]{0,4}([^\r\n]*)$/);
  if (!match) return false;
  const rest = match[2].toUpperCase();
  if (rest.length === 0 || rest.length > TOOL_CALL_CLOSE_MAX) return false;
  return CLOSER_PREFIX_LITERALS.some(literal => literal.startsWith(rest));
};

const consumeDuplicateClosers = (text, from, canGrow) => {
  let end = from;
  for (;;) {
    let probe = end;
    while (probe < text.length && /\s/.test(text[probe])) probe += 1;
    if (probe >= text.length) return { end, needMore: false };
    const head = text[probe];
    if (head !== '[' && head !== '<') return { end, needMore: false };
    const dup = consumeTrailingCloser(text, end, canGrow);
    if (dup.needMore) return { end, needMore: true };
    if (dup.end === end) return { end, needMore: false };
    end = dup.end;
  }
};

const firstNonEmptyString = (...values) =>
  values.find(value => typeof value === 'string' && value.length > 0) || null;

const escapeRawControlCharsInStrings = (jsonText) => {
  const text = String(jsonText);
  let out = '';
  let inString = false;
  let escaped = false;
  let repaired = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        out += char;
        continue;
      }
      if (char === '\\') {
        escaped = true;
        out += char;
        continue;
      }
      if (char === '"') {
        inString = false;
        out += char;
        continue;
      }
      const code = char.charCodeAt(0);
      if (code <= 0x1f) {
        repaired = true;
        if (char === '\n') out += '\\n';
        else if (char === '\r') out += '\\r';
        else if (char === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }
  return repaired ? out : null;
};

const repairLooseToolPayload = (jsonText) => {
  const text = String(jsonText);
  let out = '';
  let repaired = false;
  let inString = false;
  let escaped = false;
  let inLoose = false;
  const stack = [];
  let expectKey = false;

  const literalLengthAt = (i) => {
    const match = text.slice(i, i + 6).match(/^(true|false|null)/);
    if (!match) return 0;
    const next = text[i + match[1].length];
    return (next === undefined || next === ',' || next === '}' || next === ']' ||
        next === ' ' || next === '\t' || next === '\r' || next === '\n')
      ? match[1].length
      : 0;
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      out += char;
      continue;
    }
    if (inLoose) {
      if (char === '"') {
        inLoose = false;
        out += char;
        continue;
      }
      if (char === '\\') {
        out += '\\\\';
        continue;
      }
      const code = char.charCodeAt(0);
      if (code <= 0x1f) {
        if (char === '\n') out += '\\n';
        else if (char === '\r') out += '\\r';
        else if (char === '\t') out += '\\t';
        else out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === '{') {
      stack.push('{');
      expectKey = true;
      out += char;
      continue;
    }
    if (char === '[') {
      stack.push('[');
      expectKey = false;
      out += char;
      continue;
    }
    if (char === '}' || char === ']') {
      stack.pop();
      expectKey = false;
      out += char;
      continue;
    }
    if (char === ',') {
      expectKey = stack[stack.length - 1] === '{';
      out += char;
      continue;
    }
    if (char === ':') {
      expectKey = false;
      out += char;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
      out += char;
      continue;
    }
    if (expectKey) {
      const ident = text.slice(i).match(/^[A-Za-z_$][\w$-]*/);
      if (ident) {
        out += `"${ident[0]}"`;
        i += ident[0].length - 1;
        expectKey = false;
        repaired = true;
        continue;
      }
      out += char;
      continue;
    }
    if (char === '-' || (char >= '0' && char <= '9')) {
      const num = text.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (num) {
        out += num[0];
        i += num[0].length - 1;
        continue;
      }
    }
    const literalLen = literalLengthAt(i);
    if (literalLen > 0) {
      out += text.slice(i, i + literalLen);
      i += literalLen - 1;
      continue;
    }
    out += '"';
    inLoose = true;
    repaired = true;
    i -= 1;
  }
  return repaired ? out : null;
};

const NAME_HINT_TAIL_RE = /^\][ \t]*([A-Za-z_][\w-]{0,63})[ \t\r\n]*$/;
const extractTriggerNameHint = (triggerText, tail) => {
  if (!triggerText || triggerText.charAt(0) !== '[') return null;
  const match = String(tail || '').match(NAME_HINT_TAIL_RE);
  return match ? match[1] : null;
};

const argumentsMatchToolSchema = (name, args, toolSchemas) => {
  if (!toolSchemas || typeof toolSchemas !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(toolSchemas, name)) return false;
  const schema = toolSchemas[name];
  const properties = schema?.properties;
  if (!properties || typeof properties !== 'object') return false;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (!Object.keys(args).every(key => Object.prototype.hasOwnProperty.call(properties, key))) {
    return false;
  }
  const required = Array.isArray(schema.required) ? schema.required : [];
  return required.every(key => Object.prototype.hasOwnProperty.call(args, key));
};

const gateSalvagedPayload = (payload, salvage) =>
  !!(salvage && salvage.allowedToolNames && salvage.allowedToolNames.has(payload.name) &&
    argumentsMatchToolSchema(payload.name, payload.arguments, salvage.toolSchemas));

const stripToolCallResidue = (text, spans, options = {}) => {
  let out = String(text || '');
  if (!Array.isArray(spans) || spans.length === 0) return out;
  const channel = options.channel || null;
  const applicable = spans
    .filter(span => span && typeof span.text === 'string' && span.text &&
      Number.isInteger(span.at) && span.at >= 0 &&
      (channel ? span.channel === channel : true))
    .sort((a, b) => b.at - a.at);
  for (const span of applicable) {
    if (span.at >= out.length) continue;
    if (out.slice(span.at, span.at + span.text.length) === span.text) {
      out = out.slice(0, span.at) + out.slice(span.at + span.text.length);
      continue;
    }
    const tail = out.slice(span.at);
    if (tail.length < span.text.length && span.text.startsWith(tail)) {
      out = out.slice(0, span.at);
    }
  }
  return out;
};

const buildToolCallPayload = (jsonText, salvage = null) => {
  let parsed;
  let quoteRepaired = false;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    const repairedText = escapeRawControlCharsInStrings(jsonText);
    if (repairedText !== null) {
      try {
        parsed = JSON.parse(repairedText);
      } catch (_) {
        parsed = undefined;
      }
      if (parsed !== undefined) {
        warnTool('tool_call 负载修复：严格解析失败后转义字符串内的裸控制字符，重新解析成功');
      }
    }
    if (parsed === undefined && salvage) {
      const looseText = repairLooseToolPayload(repairedText ?? jsonText);
      if (looseText !== null) {
        try {
          parsed = JSON.parse(looseText);
          quoteRepaired = true;
        } catch (_) {
          parsed = undefined;
        }
      }
    }
    if (parsed === undefined) {
      return { error: { type: 'invalid_json', raw: jsonText, reason: error?.message } };
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: { type: 'invalid_json', raw: jsonText, reason: 'not an object' } };
  }
  const name = firstNonEmptyString(parsed.name, parsed.tool, parsed.function);
  if (!name) {
    if (salvage?.nameHint) {
      const candidate = { name: salvage.nameHint, arguments: parsed };
      if (gateSalvagedPayload(candidate, salvage)) {
        warnTool(`tool_call 负载抢救：无信封负载采用触发器尾巴名字，白名单 + schema 闸门放行${quoteRepaired ? '（含引号修复）' : ''}`);
        return { payload: candidate };
      }
      return { error: { type: 'salvage_rejected', raw: jsonText, reason: 'name-hint candidate failed the allowlist/schema gate' } };
    }
    return { error: { type: 'invalid_json', raw: jsonText, reason: 'no tool name' } };
  }
  const payload = { name, arguments: parsed.arguments ?? parsed.parameters ?? parsed.args ?? {} };
  if (quoteRepaired || salvage?.forceGate) {
    if (!gateSalvagedPayload(payload, salvage)) {
      return { error: { type: 'salvage_rejected', raw: jsonText, reason: 'repaired payload failed the allowlist/schema gate' } };
    }
    if (quoteRepaired) {
      warnTool('tool_call 负载抢救：引号修复后严格解析成功，白名单 + schema 闸门放行');
    }
  }
  return { payload };
};

const salvageTruncatedSpan = (spanText, salvage) => {
  if (!salvage) return null;
  const closerMatch = spanText.match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
  if (!closerMatch) return null;
  const region = spanText.slice(0, closerMatch.index);
  const repairedRegion = repairLooseToolPayload(region);
  if (repairedRegion === null) return null;
  const object = extractBalancedObject(repairedRegion, 0);
  if (!object) return null;
  const built = buildToolCallPayload(object.text, { ...salvage, forceGate: true });
  if (built.error) return null;
  warnTool(`truncated_tool_call 抢救成功：引号修复后负载配平并通过全部闸门（span ${spanText.length} 字符）`);
  return {
    payload: built.payload,
    end: closerMatch.index + closerMatch[0].length
  };
};

/**
 * 纠正常见的终端/代码执行工具别名映射（核心兼容修复）
 */
const resolveToolAlias = (rawName, allowedToolNames) => {
  if (!rawName) return rawName;
  const allowed = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames || []);
  if (allowed.size === 0 || allowed.has(rawName)) return rawName;

  const EXEC_ALIASES = ['exec_command', 'execute_command', 'bash', 'terminal', 'cmd', 'run_command', 'shell'];
  if (EXEC_ALIASES.includes(rawName.toLowerCase())) {
    for (const validName of EXEC_ALIASES) {
      if (allowed.has(validName)) return validName;
    }
  }
  return rawName;
};

/** allowedToolNames 闸门。支持别名重映射。 */
const gateToolName = (payload, allowedToolNames) => {
  if (allowedToolNames && payload?.name) {
    payload.name = resolveToolAlias(payload.name, allowedToolNames);
    if (!allowedToolNames.has(payload.name)) {
      return { type: 'unknown_tool', name: payload.name };
    }
  }
  return null;
};

const warnTool = (message, data) => logger.warn?.(message, 'TOOL', '', data ?? null);

const sanitizeJsonReasonForLog = (reason) => {
  const text = String(reason || '');
  const cut = text.search(/["'`‘’“”\n\r]| in JSON| at position/i);
  const head = (cut === -1 ? text : text.slice(0, cut)).trim();
  return (head || 'invalid_json').slice(0, 120);
};

const logToolError = (error) => {
  if (!error) return;
  if (error.type === 'unknown_tool') {
    warnTool(`工具调用被拒绝：${error.name} 不在 allowedToolNames 里`);
    return;
  }
  const size = typeof error.raw === 'string' ? error.raw.length : 0;
  const reason = error.type === 'invalid_json'
    ? sanitizeJsonReasonForLog(error.reason)
    : (error.reason || error.type);
  warnTool(`解析 tool_call 负载失败（${reason}，负载 ${size} 字符）`);
};

const logTriggerSuppressed = (trigger, why) => {
  warnTool(`tool_call 触发器按${why}处理，未识别为调用`, trigger);
};

const logTriggeredUnrecovered = (trigger) => {
  warnTool(
    `出现 tool_call 触发器，但其后 ${TOOL_CALL_PAYLOAD_WINDOW} 字符窗口内没有可用负载，按正文放行`,
    trigger
  );
};

const normalizeAllowedToolNames = (allowedToolNames) => {
  if (!allowedToolNames) return null;
  const names = allowedToolNames instanceof Set ? allowedToolNames : new Set(allowedToolNames);
  return names.size > 0 ? names : null;
};

const serializeToolArguments = (args) => {
  if (typeof args === 'string') {
    try {
      JSON.parse(args);
      return args;
    } catch (_) {
      return JSON.stringify(args);
    }
  }
  return JSON.stringify(args ?? {});
};

const compactDescription = (value, maxLength = 320) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
};

const looksLikeUnexecutedToolAction = (value) => {
  const text = String(value || '').trim().replace(/^[#>*\-\s]+/, '');
  const english = /^(?:i(?:['’]ll| will)|let me|i need to|next,?\s+i(?:['’]ll| will))\s+(?:now\s+)?(?:run|execute|check|inspect|read|edit|write|search|open|call|use|look|test|verify|build|deploy|create|update|fetch)\b/i;
  const chinese = /^(?:我(?:将|会|先|需要|正在)|让我|接下来(?:我)?(?:将|会|先)?|现在(?:我)?(?:将|会|先|来)?|下面(?:我)?(?:将|会|先)?|正在)(?:立即|马上|先|来)?(?:运行|执行|检查|查看|读取|编辑|修改|写入|搜索|打开|调用|使用|测试|验证|构建|部署|创建|更新|获取)/;
  return english.test(text) || chinese.test(text);
};

const TOOL_CALL_CLOSE_BRACKET_SCAN_RE = new RegExp(TOOL_CALL_CLOSE_BRACKET_RE.source.replace(/^\^/, ''), 'i');
const containsOrphanProtocolResidue = (value) => {
  const text = String(value || '');
  if (TOOL_CALL_CLOSE_BRACKET_SCAN_RE.test(text)) return true;
  return isLeakedToolPayloadShape(text);
};

const logSyntheticRejected = (reason) => {
  warnTool(`裸负载抢救被拒绝（${reason}），按正文放行`);
};

const recordOrphanBracketClosers = (text, spans) => {
  if (!TOOL_CALL_CLOSE_BRACKET_SCAN_RE.test(text)) return;
  const tracker = createCodeContextTracker();
  let from = 0;
  for (;;) {
    const match = text.slice(from).match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
    if (!match) return;
    const at = from + match.index;
    tracker.consume(text.slice(from, at));
    const insideRecorded = spans.some(span =>
      typeof span.text === 'string' && at >= span.at && at < span.at + span.text.length);
    if (!tracker.inCode() && !insideRecorded) {
      spans.push({ text: match[0], at });
    }
    tracker.consume(text.slice(at, at + match[0].length));
    from = at + match[0].length;
  }
};

const createToolCallObject = (payload, index = 0, id = null) => ({
  index,
  id: id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
  type: 'function',
  function: {
    name: payload.name,
    arguments: serializeToolArguments(payload.arguments)
  }
});

const compressSchemaType = (schema) => {
  if (!schema || typeof schema !== 'object') {
    return 'any';
  }

  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return schema.enum.map(value => JSON.stringify(value)).join(' | ');
  }

  const type = schema.type;

  if (type === 'array') {
    const itemType = compressSchemaType(schema.items);
    return `${itemType}[]`;
  }

  if (type === 'object') {
    if (!schema.properties || typeof schema.properties !== 'object') {
      return 'object';
    }
    const requiredKeys = new Set(Array.isArray(schema.required) ? schema.required : []);
    const fields = Object.entries(schema.properties).map(([key, value]) => {
      const optional = requiredKeys.has(key) ? '' : '?';
      const description = compactDescription(value?.description, 180);
      return `${key}${optional}: ${compressSchemaType(value)}${description ? ` /* ${description.replace(/\*\//g, '* /')} */` : ''}`;
    });
    return `{ ${fields.join('; ')} }`;
  }

  if (Array.isArray(type)) {
    return type.map(t => compressSchemaType({ ...schema, type: t })).join(' | ');
  }

  return type || 'any';
};

const compressToolDefinition = (tool) => {
  const fn = tool?.function || tool;
  const name = fn?.name || 'unknown';
  const description = compactDescription(fn?.description);
  const params = fn?.parameters || { type: 'object', properties: {} };
  const signature = compressSchemaType(params);

  if (description) {
    return `- ${name}${signature}\n  ${description}`;
  }
  return `- ${name}${signature}`;
};

const buildToolSystemPrompt = (tools, options = {}) => {
  if (!Array.isArray(tools) || tools.length === 0) {
    return '';
  }

  const compressed = tools
    .map(compressToolDefinition)
    .filter(Boolean)
    .join('\n');

  const lines = [
    '# Tools',
    '',
    'You have access to the following tools. This is an Agent tool protocol, not a suggestion.',
    '',
    '## Available tools',
    compressed,
    '',
    '## Output format',
    'Emit each tool invocation as:',
    '',
    TOOL_CALL_OPEN,
    '{"name": "<tool_name>", "arguments": {<json_arguments>}}',
    TOOL_CALL_CLOSE,
    '',
    'Tool results come back to you as user messages in this form:',
    '',
    `${TOOL_RESULT_OPEN}<tool_name>]`,
    '<result text or JSON>',
    TOOL_RESULT_CLOSE,
    '',
    'Rules:',
    `- If the task requires reading, writing, editing, searching, shell execution, browser use, or any action covered by an available tool, your visible response MUST be a \`${TOOL_CALL_OPEN}\` block. Call the tool instead of describing the action.`,
    '- A tool call must be the first non-whitespace content of the visible answer. Do not write “I will…”, “Let me…”, “我将…”, “正在…”, a plan, or a completion claim before it.',
    `- The JSON inside \`${TOOL_CALL_OPEN}\` must be valid and on a single logical block.`,
    `- Write the opening marker as exactly \`${TOOL_CALL_OPEN}\` and the closing marker as exactly \`${TOOL_CALL_CLOSE}\`, each on its own line. They never take attributes, an id, or the tool name — everything the call needs is inside the JSON.`,
    '- Use the exact tool name listed above.',
    '- Provide all required arguments; omit unknown ones.',
    `- You may emit multiple \`${TOOL_CALL_OPEN}\` blocks back-to-back when more than one tool is needed.`,
    '- After every tool result, evaluate the actual task state. If work remains, emit the next tool call. Only return a normal-language final answer after the requested task is genuinely complete or you are blocked on user input.',
    '- Never claim that a file was changed, a command succeeded, or a result was verified unless the corresponding tool result proves it.',
    `- Do not call nonexistent tools, fabricate tool results, wrap \`${TOOL_CALL_OPEN}\` in code fences, or mix extra commentary into a tool-call turn.`,
    '- A non-tool response is valid only when it explicitly declares its state: use the completion or blocked wrapper below. Bare prose is invalid.',
    `- Verified completion: ${AGENT_FINAL_OPEN}final report${AGENT_FINAL_CLOSE}`,
    `- Requires user input/authority: ${AGENT_BLOCKED_OPEN}exact blocker${AGENT_BLOCKED_CLOSE}`,
    '- Never emit the completion wrapper after merely finishing one intermediate tool action; continue with another tool call until every requested outcome is verified.'
  ];

  const choice = options.tool_choice;
  if (choice === 'required') {
    lines.push('- You MUST call at least one tool before answering.');
  } else if (choice && typeof choice === 'object' && choice.function?.name) {
    lines.push(`- You MUST call the tool \`${choice.function.name}\` first.`);
  } else if (choice === 'none') {
    lines.push('- Do NOT call any tool for this turn; respond as plain text.');
  }

  return lines.join('\n');
};

const foldToolMessages = (messages) => {
  if (!Array.isArray(messages)) return messages;

  const callIdToName = new Map();

  return messages.map((message) => {
    if (!message || typeof message !== 'object') return message;

    const assistantCalls = message.role === 'assistant'
      ? (Array.isArray(message.tool_calls) && message.tool_calls.length > 0
        ? message.tool_calls
        : (message.function_call?.name ? [message.function_call] : []))
      : [];
    if (assistantCalls.length > 0) {
      const blocks = assistantCalls.map((call) => {
        const fn = call?.function || call;
        let args = fn?.arguments;
        if (typeof args === 'string') {
          try {
            args = JSON.parse(args);
          } catch (_) {
          }
        }
        const name = fn?.name || 'unknown';
        const id = call?.id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`;
        callIdToName.set(id, name);
        const payload = { name, arguments: args ?? {} };
        return `${TOOL_CALL_OPEN}\n${JSON.stringify(payload)}\n${TOOL_CALL_CLOSE}`;
      });
      const original = typeof message.content === 'string' ? message.content : '';
      return {
        role: 'assistant',
        content: [original, blocks.join('\n')].filter(Boolean).join('\n')
      };
    }

    if (message.role === 'tool' || message.role === 'function') {
      const callId = message.tool_call_id || '';
      const name = message.name || callIdToName.get(callId) || (message.role === 'function' ? 'function' : 'tool');
      const content = typeof message.content === 'string'
        ? (message.content || 'null')
        : JSON.stringify(message.content ?? null);
      return {
        role: 'user',
        content: `${TOOL_RESULT_OPEN}${sanitizeMarkerName(name)}]\n${neutraliseResultMarkers(content)}\n${TOOL_RESULT_CLOSE}`
      };
    }

    return message;
  });
};

const neutraliseResultMarkers = (value) => String(value)
  .replace(/\[[ \t]*END[ \t]+TOOL[ \t]+RESULT[ \t]*\]/gi, '(END TOOL RESULT)')
  .replace(/\[[ \t]*TOOL[ \t]+RESULT[ \t]*:/gi, '(TOOL RESULT:')
  .replace(/\[(?=[ \t]{0,4}tool[ \t_-]{1,2}calls?)/gi, '(')
  .replace(/\[(?=[ \t]{0,4}(?:END[ \t_-]{1,2}|\/[ \t]{0,4})TOOL[ \t_-]{1,2}CALLs?)/gi, '(')
  .replace(/<(?=[ \t]{0,4}\/?[ \t]{0,4}tool_calls?)/gi, '(');

const sanitizeMarkerName = (value) => String(value || '')
  .replace(/[[\]\r\n]/g, ' ')
  .trim() || 'tool';

const parseToolCallsFromText = (fullText, options = {}) => {
  const allowedToolNames = normalizeAllowedToolNames(options.allowedToolNames);
  const salvage = !!allowedToolNames;
  const repairSalvage = allowedToolNames && options.toolSchemas
    ? { allowedToolNames, toolSchemas: options.toolSchemas }
    : null;

  if (typeof fullText !== 'string' ||
      !(TOOL_CALL_TRIGGER_RE.test(fullText) || (salvage && isLeakedToolPayloadShape(fullText)))) {
    const fastPathSpans = [];
    if (typeof fullText === 'string') recordOrphanBracketClosers(fullText, fastPathSpans);
    return { cleanedText: fullText || '', toolCalls: [], errors: [], warnings: [], residueSpans: fastPathSpans };
  }

  const toolCalls = [];
  const errors = [];
  const warnings = [];
  const residueSpans = [];
  const code = createCodeContextTracker();

  let cleanedText = '';
  let position = 0;
  let emittedProse = false;

  const releaseProse = (text) => {
    if (!text) return;
    code.consume(text);
    cleanedText += text;
    if (/\S/.test(text)) emittedProse = true;
  };

  const releaseDebris = (text) => { cleanedText += text; };

  const releaseRejectedSpan = (text) => {
    if (!text) return;
    cleanedText += text;
    if (/\S/.test(text)) emittedProse = true;
  };

  const resolveSyntheticAt = (from) => {
    const object = extractBalancedObject(fullText, from);
    if (!object) {
      warnings.push({ type: 'synthetic_rejected', reason: 'unbalanced payload', raw: '' });
      logSyntheticRejected('unbalanced payload');
      const next = fullText.slice(from).match(TOOL_CALL_TRIGGER_RE);
      const cut = next ? from + next.index : fullText.length;
      residueSpans.push({ text: fullText.slice(from, cut), at: cleanedText.length });
      releaseDebris(fullText.slice(from, cut));
      return cut;
    }
    const closer = consumeMandatoryBracketCloser(fullText, object.end, false);
    if (!closer.found) {
      warnings.push({ type: 'synthetic_rejected', reason: 'missing closer', raw: '' });
      logSyntheticRejected('missing closer');
      releaseRejectedSpan(object.text);
      return object.end;
    }
    const built = buildToolCallPayload(object.text, repairSalvage);
    const gateError = built.error || gateToolName(built.payload, allowedToolNames);
    if (gateError) {
      warnings.push({ type: 'synthetic_rejected', reason: gateError.type, raw: '' });
      logSyntheticRejected(gateError.type);
      releaseRejectedSpan(fullText.slice(from, closer.end));
      return closer.end;
    }
    toolCalls.push(createToolCallObject(built.payload, toolCalls.length));
    return consumeDuplicateClosers(fullText, closer.end, false).end;
  };

  while (position < fullText.length) {
    const opening = matchToolCallOpening(fullText.slice(position), {
      emittedProse: emittedProse || code.inCode(),
      canSalvage: salvage
    });
    if (!opening) break;

    const triggerAt = position + opening.index;
    releaseProse(fullText.slice(position, triggerAt));

    if (opening.synthetic) {
      position = resolveSyntheticAt(triggerAt);
      continue;
    }

    const trigger = opening.text;
    const afterTrigger = triggerAt + trigger.length;

    const suppress = (reason, log) => {
      warnings.push({ type: 'triggered_unrecovered', reason, raw: trigger });
      log(trigger, reason);
      releaseProse(trigger);
      position = afterTrigger;
    };

    if (code.inCode()) {
      suppress('inside code context', logTriggerSuppressed);
      continue;
    }

    const payloadAt = findPayloadStart(fullText, afterTrigger, false);
    if (payloadAt < 0) {
      suppress('no payload in window', logTriggeredUnrecovered);
      continue;
    }

    if (isMarkdownLinkTail(trigger, fullText.slice(afterTrigger, payloadAt))) {
      suppress('markdown link, not a call', logTriggerSuppressed);
      continue;
    }

    const object = extractBalancedObject(fullText, payloadAt);
    const tail = fullText.slice(afterTrigger, payloadAt);
    const nameHint = repairSalvage ? extractTriggerNameHint(trigger, tail) : null;
    if (!object) {
      const salvaged = repairSalvage && !emittedProse
        ? salvageTruncatedSpan(fullText.slice(payloadAt), { ...repairSalvage, nameHint })
        : null;
      if (salvaged) {
        toolCalls.push(createToolCallObject(salvaged.payload, toolCalls.length));
        position = consumeDuplicateClosers(fullText, payloadAt + salvaged.end, false).end;
        continue;
      }
      const error = { type: 'truncated_tool_call', raw: fullText.slice(afterTrigger) };
      errors.push(error);
      logToolError(error);
      const spanTail = fullText.slice(payloadAt);
      const closerMatch = spanTail.match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
      const condemnedEnd = closerMatch
        ? payloadAt + closerMatch.index + closerMatch[0].length
        : payloadAt;
      residueSpans.push({ text: fullText.slice(triggerAt, condemnedEnd), at: cleanedText.length });
      releaseProse(trigger);
      position = afterTrigger;
      continue;
    }

    const afterFence = skipTrailingFence(fullText, object.end, tail, false).end;
    const closer = consumeTrailingCloser(fullText, afterFence, false);
    const spanEnd = Math.max(afterFence, closer.end);
    const span = fullText.slice(triggerAt, spanEnd);


    const built = buildToolCallPayload(object.text, repairSalvage ? { ...repairSalvage, nameHint } : null);
    const error = built.error || gateToolName(built.payload, allowedToolNames);
    if (error) {
      errors.push(error);
      logToolError(error);
      residueSpans.push({ text: span, at: cleanedText.length });
      releaseDebris(span);
      position = spanEnd;
      continue;
    }

    toolCalls.push(createToolCallObject(built.payload, toolCalls.length));
    position = closer.end > afterFence
      ? consumeDuplicateClosers(fullText, closer.end, false).end
      : spanEnd;
  }

  releaseProse(fullText.slice(position));
  const leadingTrim = cleanedText.length - cleanedText.trimStart().length;
  const trimmedCleanedText = cleanedText.trim();
  const adjustedSpans = residueSpans.map(span => ({ ...span, at: span.at - leadingTrim }));
  recordOrphanBracketClosers(trimmedCleanedText, adjustedSpans);
  return {
    cleanedText: trimmedCleanedText,
    toolCalls,
    errors,
    warnings,
    residueSpans: adjustedSpans
  };
};

const createToolCallStreamParser = (options = {}) => {
  const allowedToolNames = normalizeAllowedToolNames(options.allowedToolNames);
  const salvage = !!allowedToolNames;
  const repairSalvage = allowedToolNames && options.toolSchemas
    ? { allowedToolNames, toolSchemas: options.toolSchemas }
    : null;
  const errors = [];
  const warnings = [];
  const residueSpans = [];
  let textDeltaLength = 0;
  let recoveredLength = 0;
  const code = createCodeContextTracker();
  let pendingText = '';
  let triggerText = '';
  let afterTrigger = '';
  let inToolCall = false;
  let syntheticTrigger = false;
  let closerSwallow = false;
  let emittedCallCount = 0;
  let emittedProse = false;

  const releaseProse = (result, text) => {
    if (!text) return;
    code.consume(text);
    textDeltaLength += text.length;
    result.textDelta += text;
    if (/\S/.test(text)) emittedProse = true;
  };

  const releaseDebris = (result, text) => {
    if (!text) return;
    textDeltaLength += text.length;
    result.textDelta += text;
  };

  const releaseRejectedSpan = (result, text) => {
    if (!text) return;
    textDeltaLength += text.length;
    result.textDelta += text;
    if (/\S/.test(text)) emittedProse = true;
  };

  const splitSafeText = (text) => {
    const lastOpen = Math.max(text.lastIndexOf('<'), text.lastIndexOf('['));
    if (lastOpen !== -1 && text.length - lastOpen <= TOOL_CALL_TRIGGER_MAX) {
      return { safe: text.slice(0, lastOpen), remainder: text.slice(lastOpen) };
    }
    return { safe: text, remainder: '' };
  };

  const resolveTriggered = (result, flushing) => {
    const finish = (leftover) => {
      triggerText = '';
      afterTrigger = '';
      inToolCall = false;
      syntheticTrigger = false;
      return leftover;
    };

    if (syntheticTrigger) {
      const object = extractBalancedObject(afterTrigger, 0);
      if (!object) {
        if (!flushing && afterTrigger.length <= TOOL_CALL_SPAN_MAX) return null;
        warnings.push({ type: 'synthetic_rejected', reason: 'unbalanced payload', raw: '' });
        logSyntheticRejected('unbalanced payload');
        const next = afterTrigger.match(TOOL_CALL_TRIGGER_RE);
        if (next) {
          residueSpans.push({ text: afterTrigger.slice(0, next.index), at: textDeltaLength, channel: 'text' });
          releaseDebris(result, afterTrigger.slice(0, next.index));
          return finish(afterTrigger.slice(next.index));
        }
        if (!flushing) {
          const keep = Math.min(TOOL_CALL_TRIGGER_MAX, afterTrigger.length);
          residueSpans.push({ text: afterTrigger.slice(0, afterTrigger.length - keep), at: textDeltaLength, channel: 'text' });
          releaseDebris(result, afterTrigger.slice(0, afterTrigger.length - keep));
          return finish(afterTrigger.slice(afterTrigger.length - keep));
        }
        residueSpans.push({ text: afterTrigger, at: textDeltaLength, channel: 'text' });
        releaseDebris(result, afterTrigger);
        return finish('');
      }
      const closer = consumeMandatoryBracketCloser(afterTrigger, object.end, !flushing);
      if (closer.needMore) {
        if (afterTrigger.length <= TOOL_CALL_SPAN_MAX) return null;
      }
      if (!closer.found) {
        warnings.push({ type: 'synthetic_rejected', reason: 'missing closer', raw: '' });
        logSyntheticRejected('missing closer');
        releaseRejectedSpan(result, object.text);
        return finish(afterTrigger.slice(object.end));
      }
      const built = buildToolCallPayload(object.text, repairSalvage);
      const gateError = built.error || gateToolName(built.payload, allowedToolNames);
      if (gateError) {
        warnings.push({ type: 'synthetic_rejected', reason: gateError.type, raw: '' });
        logSyntheticRejected(gateError.type);
        releaseRejectedSpan(result, afterTrigger.slice(0, closer.end));
        return finish(afterTrigger.slice(closer.end));
      }
      result.completedCalls.push(createToolCallObject(built.payload, emittedCallCount));
      emittedCallCount += 1;
      closerSwallow = true;
      return finish(afterTrigger.slice(closer.end));
    }

    const suppress = (reason, log) => {
      warnings.push({ type: 'triggered_unrecovered', reason, raw: triggerText });
      log(triggerText, reason);
      releaseProse(result, triggerText);
      return finish(afterTrigger);
    };

    const payloadAt = findPayloadStart(afterTrigger, 0, !flushing);
    if (payloadAt === -2) return null;
    if (payloadAt === -1) return suppress('no payload in window', logTriggeredUnrecovered);

    if (isMarkdownLinkTail(triggerText, afterTrigger.slice(0, payloadAt))) {
      return suppress('markdown link, not a call', logTriggerSuppressed);
    }

    const object = extractBalancedObject(afterTrigger, payloadAt);
    if (!object) {
      if (!flushing && afterTrigger.length <= TOOL_CALL_SPAN_MAX) return null;
      const salvaged = flushing && repairSalvage && !emittedProse
        ? salvageTruncatedSpan(afterTrigger.slice(payloadAt), {
          ...repairSalvage,
          nameHint: extractTriggerNameHint(triggerText, afterTrigger.slice(0, payloadAt))
        })
        : null;
      if (salvaged) {
        result.completedCalls.push(createToolCallObject(salvaged.payload, emittedCallCount));
        emittedCallCount += 1;
        closerSwallow = true;
        return finish(afterTrigger.slice(payloadAt + salvaged.end));
      }
      const error = {
        type: 'truncated_tool_call',
        raw: afterTrigger,
        ...(afterTrigger.length > TOOL_CALL_SPAN_MAX ? { reason: 'span exceeded buffer cap' } : {})
      };
      errors.push(error);
      logToolError(error);
      const spanTail = afterTrigger.slice(payloadAt);
      const closerMatch = spanTail.match(TOOL_CALL_CLOSE_BRACKET_SCAN_RE);
      const condemnedEnd = closerMatch
        ? payloadAt + closerMatch.index + closerMatch[0].length
        : payloadAt;
      residueSpans.push({
        text: triggerText + afterTrigger.slice(0, condemnedEnd),
        at: recoveredLength,
        channel: 'recovered'
      });
      recoveredLength += triggerText.length + afterTrigger.length;
      result.recoveredText += triggerText + afterTrigger;
      return finish('');
    }

    const tail = afterTrigger.slice(0, payloadAt);
    const fence = skipTrailingFence(afterTrigger, object.end, tail, !flushing);
    if (fence.needMore) return null;
    const afterFence = fence.end;
    const closer = consumeTrailingCloser(afterTrigger, afterFence, !flushing);
    if (closer.needMore) return null;

    const spanEnd = Math.max(afterFence, closer.end);
    const span = triggerText + afterTrigger.slice(0, spanEnd);
    const leftover = afterTrigger.slice(spanEnd);

    const built = buildToolCallPayload(object.text, repairSalvage
      ? { ...repairSalvage, nameHint: extractTriggerNameHint(triggerText, tail) }
      : null);
    const error = built.error || gateToolName(built.payload, allowedToolNames);
    if (error) {
      errors.push(error);
      logToolError(error);
      residueSpans.push({ text: span, at: recoveredLength, channel: 'recovered' });
      recoveredLength += span.length;
      result.recoveredText += span;
      return finish(leftover);
    }

    result.completedCalls.push(createToolCallObject(built.payload, emittedCallCount));
    emittedCallCount += 1;
    if (closer.end > afterFence) closerSwallow = true;
    return finish(leftover);
  };

  const drain = (chunk, result, flushing) => {
    let buffer = chunk;

    for (;;) {
      if (inToolCall) {
        afterTrigger += buffer;
        const leftover = resolveTriggered(result, flushing);
        if (leftover === null) return;
        buffer = leftover;
        continue;
      }

      pendingText += buffer;
      if (!pendingText) return;

      if (closerSwallow) {
        const probe = pendingText.search(/\S/);
        if (probe === -1) {
          if (!flushing) return;
          closerSwallow = false;
        } else if (pendingText[probe] === '[' || pendingText[probe] === '<') {
          const dup = consumeTrailingCloser(pendingText, 0, !flushing);
          if (dup.needMore) return;
          if (dup.end > 0) {
            pendingText = pendingText.slice(dup.end);
            buffer = '';
            continue;
          }
          if (flushing && isDanglingCloserPrefix(pendingText.slice(probe))) {
            pendingText = '';
            closerSwallow = false;
            return;
          }
          closerSwallow = false;
        } else {
          closerSwallow = false;
        }
      }

      if (!flushing && salvage && !emittedProse && !code.inCode() &&
          !isLeakedToolPayloadShape(pendingText)) {
        const braceAt = pendingText.search(/\S/);
        if (braceAt !== -1 && pendingText[braceAt] === '{' &&
            pendingText.length <= TOOL_CALL_SPAN_MAX &&
            !extractBalancedObject(pendingText, braceAt)) {
          const held = pendingText.slice(braceAt);
          if (held.length < LEAKED_PAYLOAD_NAME_WINDOW ||
              LEAKED_PAYLOAD_NAME_RE.test(held.slice(0, LEAKED_PAYLOAD_NAME_WINDOW))) {
            return;
          }
        }
      }

      const opening = matchToolCallOpening(pendingText, {
        emittedProse: emittedProse || code.inCode(),
        canSalvage: salvage
      });
      if (opening) {
        const before = pendingText.slice(0, opening.index);
        releaseProse(result, before);
        const tail = pendingText.slice(opening.index + opening.text.length);
        pendingText = '';
        if (!opening.synthetic && code.inCode()) {
          warnings.push({ type: 'triggered_unrecovered', reason: 'inside code context', raw: opening.text });
          logTriggerSuppressed(opening.text, 'inside code context');
          releaseProse(result, opening.text);
        } else {
          triggerText = opening.text;
          syntheticTrigger = opening.synthetic;
          afterTrigger = '';
          inToolCall = true;
        }
        buffer = tail;
        continue;
      }

      if (flushing) {
        releaseProse(result, pendingText);
        pendingText = '';
        return;
      }

      const { safe, remainder } = splitSafeText(pendingText);
      releaseProse(result, safe);
      pendingText = remainder;
      return;
    }
  };

  const push = (chunk) => {
    const result = { textDelta: '', recoveredText: '', completedCalls: [] };
    if (typeof chunk !== 'string' || chunk.length === 0) return result;
    drain(chunk, result, false);
    return result;
  };

  const flush = () => {
    const result = { textDelta: '', recoveredText: '', completedCalls: [] };
    drain('', result, true);
    return result;
  };

  return {
    push,
    flush,
    hasPendingCall: () => inToolCall,
    hasEmittedAnyCall: () => emittedCallCount > 0,
    hasParseError: () => errors.length > 0,
    getErrors: () => [...errors],
    hasTriggeredWithoutCall: () => warnings.some(w => w.type === 'triggered_unrecovered'),
    getWarnings: () => [...warnings],
    getResidueSpans: () => residueSpans.map(span => ({ ...span }))
  };
};

const createNativeToolCallAccumulator = (options = {}) => {
  const allowedToolNames = normalizeAllowedToolNames(options.allowedToolNames);
  const calls = new Map();
  const errors = [];

  const push = (deltas) => {
    if (!Array.isArray(deltas)) return;
    for (const delta of deltas) {
      if (!delta || typeof delta !== 'object') continue;
      const index = Number.isInteger(delta.index) ? delta.index : calls.size;
      const current = calls.get(index) || {
        index,
        id: delta.id || null,
        type: delta.type || 'function',
        function: { name: '', arguments: '' }
      };
      if (delta.id) current.id = delta.id;
      if (delta.type) current.type = delta.type;
      if (typeof delta.function?.name === 'string' && delta.function.name) {
        const incomingName = delta.function.name;
        if (!current.function.name) {
          current.function.name = incomingName;
        } else if (incomingName === current.function.name || current.function.name.endsWith(incomingName)) {
        } else if (incomingName.startsWith(current.function.name)) {
          current.function.name = incomingName;
        } else {
          current.function.name += incomingName;
        }
      }
      if (typeof delta.function?.arguments === 'string') current.function.arguments += delta.function.arguments;
      calls.set(index, current);
    }
  };

  const finalize = () => {
    const finalized = [];
    for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
      if (!call.function.name) {
        errors.push({ type: 'missing_tool_name', index });
        continue;
      }

      call.function.name = resolveToolAlias(call.function.name, allowedToolNames);

      if (allowedToolNames && !allowedToolNames.has(call.function.name)) {
        errors.push({ type: 'unknown_tool', name: call.function.name });
        continue;
      }
      try {
        JSON.parse(call.function.arguments || '{}');
      } catch (_) {
        errors.push({ type: 'invalid_arguments', name: call.function.name });
        continue;
      }
      finalized.push({
        index: finalized.length,
        id: call.id || `call_${generateUUID().replace(/-/g, '').slice(0, 24)}`,
        type: 'function',
        function: {
          name: call.function.name,
          arguments: call.function.arguments || '{}'
        }
      });
    }
    return finalized;
  };

  return {
    push,
    finalize,
    hasAny: () => calls.size > 0,
    hasParseError: () => errors.length > 0,
    getErrors: () => [...errors]
  };
};

module.exports = {
  TOOL_CALL_OPEN,
  TOOL_CALL_CLOSE,
  TOOL_RESULT_OPEN,
  TOOL_RESULT_CLOSE,
  TOOL_CALL_PAYLOAD_WINDOW,
  buildToolSystemPrompt,
  foldToolMessages,
  parseToolCallsFromText,
  createToolCallStreamParser,
  createNativeToolCallAccumulator,
  looksLikeUnexecutedToolAction,
  containsOrphanProtocolResidue,
  isLeakedToolPayloadShape,
  matchToolCallOpening,
  normalizeAllowedToolNames,
  serializeToolArguments,
  escapeRawControlCharsInStrings,
  stripToolCallResidue,
  repairLooseToolPayload
};
