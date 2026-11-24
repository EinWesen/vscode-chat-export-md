type JsonRecord = Record<string, unknown>;

export type ToolCallMode = 'full' | 'summary' | 'omit';

// JSON access helpers
function isRecord(value: unknown): value is JsonRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordField(record: JsonRecord, key: string): JsonRecord {
	const value = record[key];
	return isRecord(value) ? value : {};
}

function arrayField(record: JsonRecord, key: string): unknown[] {
	const value = record[key];
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown, fallback = ''): string {
	if (value === undefined) {
		return fallback;
	}
	if (typeof value === 'string') {
		return value;
	}
	if (value === null) {
		return 'None';
	}
	if (typeof value === 'object') {
		return JSON.stringify(value);
	}
	return String(value);
}

function fieldString(record: JsonRecord, key: string, fallback = ''): string {
	return stringValue(record[key], fallback);
}

function isTruthy(value: unknown): boolean {
	if (value === undefined || value === null || value === false || value === 0 || value === '') {
		return false;
	}
	if (Array.isArray(value)) {
		return value.length > 0;
	}
	if (isRecord(value)) {
		return Object.keys(value).length > 0;
	}
	return true;
}

function jsonText(value: unknown): string {
	return JSON.stringify(value);
}

// Response-part and tool formatting
function extractTextFromResponsePart(
	part: unknown,
	toolCallMode: ToolCallMode,
	toolCallRounds: unknown[]
): string {
	if (isRecord(part)) {
		const kind = fieldString(part, 'kind');
		if (kind === 'textEditGroup') {
			return `__TEXT_EDIT_GROUP__${jsonText(part)}__TEXT_EDIT_GROUP__`;
		}
		if (['inlineReference', 'undoStop', 'codeblockUri'].includes(kind)) {
			return '';
		}
		if (kind === 'toolInvocationSerialized') {
			return `__TOOL_INVOCATION__${jsonText(part)}__TOOL_INVOCATION__`;
		}
		if (kind === 'progressTaskSerialized') {
			return `__PROGRESS_TASK__${jsonText(part)}__PROGRESS_TASK__`;
		}
		if (kind === 'prepareToolInvocation') {
			return '';
		}

		const content = part.content;
		const invocationMessage = part.invocationMessage;
		const pastTenseMessage = part.pastTenseMessage;
		if (toolCallMode !== 'full' && isRecord(invocationMessage) && 'value' in invocationMessage) {
			return toolCallMode === 'omit' ? '' : formatToolInvocationSummary(part, toolCallRounds);
		}
		if (toolCallMode !== 'full' && isRecord(pastTenseMessage) && 'value' in pastTenseMessage) {
			return toolCallMode === 'omit' ? '' : formatToolInvocationSummary(part, toolCallRounds);
		}
		if (isRecord(content) && 'value' in content) {
			return `*${stringValue(content.value)}*`;
		}
		if (isRecord(invocationMessage) && 'value' in invocationMessage) {
			return `*${stringValue(invocationMessage.value)}*`;
		}
		if (isRecord(pastTenseMessage) && 'value' in pastTenseMessage) {
			return `*${stringValue(pastTenseMessage.value)}*`;
		}

		if (('$mid' in part) || ('id' in part && ('kind' in part || '$mid' in part)) || 'inlineReference' in part) {
			return '';
		}
		if ('value' in part) {
			const value = part.value;
			if (typeof value === 'string' && value.includes('{') && value.includes('$mid')) {
				return '';
			}
			if (typeof value === 'string' && value.trim() === '```') {
				return '';
			}
			return stringValue(value);
		}
		if (typeof part.content === 'string') {
			return part.content;
		}
		if (isRecord(part.content) && 'value' in part.content) {
			return stringValue(part.content.value);
		}
	}

	if (typeof part === 'string' && part.includes('{') && (part.includes('$mid') || part.includes('kind'))) {
		return '';
	}
	return isTruthy(part) ? stringValue(part) : '';
}

function formatMessageText(text: string): string {
	if (!text) {
		return '';
	}

	if (text.includes('{') && (text.includes('$mid') || text.includes('kind'))) {
		text = text.split('\n').filter(line => !(line.includes('{') && (line.includes('$mid') || line.includes('kind')))).join('\n');
	}

	const lines = text.split('\n');
	const formattedLines = lines.map((line, index) => {
		const startsWithCheck = line.trim().startsWith('✅');
		const previousLine = lines[index - 1] ?? '';
		if (startsWithCheck && index > 0 && previousLine.trim().startsWith('✅')) {
			return `<br>${line}`;
		}
		return line;
	}).map(line => line.trimEnd());

	const resultLines: string[] = [];
	let previousBlank = false;
	for (const line of formattedLines) {
		const isBlank = line.trim() === '';
		if (isBlank && previousBlank) {
			continue;
		}
		if (line.trim() && !(line.includes('{') && (line.includes('$mid') || line.includes('kind')))) {
			resultLines.push(line);
		} else if (isBlank) {
			resultLines.push(line);
		}
		previousBlank = isBlank;
	}

	while (resultLines.length > 0 && resultLines[resultLines.length - 1].trim() === '') {
		resultLines.pop();
	}
	return resultLines.join('\n');
}

function formatErrorMessage(errorDetails: unknown): string {
	if (!isRecord(errorDetails)) {
		return '';
	}
	const message = fieldString(errorDetails, 'message').trim();
	if (!message) {
		return '';
	}

	const lines: string[] = [];
	for (const [index, line] of message.split('\n').entries()) {
		const trimmed = line.trim();
		if (trimmed) {
			lines.push(index === 0 ? `> 🚫 ${trimmed}` : `> ${trimmed}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}

function formatReferences(variables: unknown[]): string {
	if (variables.length === 0) {
		return '';
	}

	const contentLines: string[] = [];
	let referenceCount = 0;
	for (const variable of variables) {
		if (!isRecord(variable)) {
			continue;
		}
		const name = fieldString(variable, 'name', 'Unknown');
		const kind = fieldString(variable, 'kind');
		const originLabel = fieldString(variable, 'originLabel');
		const isPrompt = name.startsWith('prompt:');
		contentLines.push(`${isPrompt ? '☰' : '📄'} ${isPrompt ? name.slice(7) : name}`);
		referenceCount++;

		if (kind === 'promptFile' && originLabel.includes('github.copilot.chat.')) {
			const labelPart = originLabel.split('github.copilot.chat.').at(-1)?.split(' ')[0] ?? '';
			contentLines.push(`⚙️ github.copilot.chat.${labelPart}`);
			referenceCount++;
		}
	}

	return `<details>
  <summary>Used ${referenceCount} references</summary>
  <p>${contentLines.join('<br>')}</p>
</details>


`;
}

function extractContentFromToolResult(toolResult: unknown): string {
	if (!isRecord(toolResult)) {
		return '';
	}
	const content = arrayField(toolResult, 'content');
	if (content.length === 0) {
		return '';
	}

	const textParts: string[] = [];
	const extractRecursive = (node: unknown): void => {
		if (Array.isArray(node)) {
			for (const child of node) {
				extractRecursive(child);
			}
			return;
		}
		if (!isRecord(node)) {
			return;
		}

		if (typeof node.text === 'string' && node.text.trim()) {
			textParts.push(node.text);
		}
		if (Array.isArray(node.children)) {
			extractRecursive(node.children);
		}
		if (isRecord(node.value)) {
			extractRecursive(node.value);
		}
		if ('node' in node) {
			extractRecursive(node.node);
		}
	};

	for (const item of content) {
		extractRecursive(item);
	}
	if (textParts.length === 0) {
		return '';
	}

	let fullText = textParts.join('').trim();
	if (fullText.startsWith('```') && fullText.endsWith('```')) {
		const lines = fullText.split('\n');
		if (lines.length >= 2 && lines[0].trim().startsWith('```') && lines[lines.length - 1].trim() === '```') {
			fullText = lines.slice(1, -1).join('\n');
		}
	}
	return fullText;
}

function findReadFileResult(
	invocationMessage: string,
	toolCallResults: JsonRecord,
	toolCallRounds: unknown[]
): string {
	if (Object.keys(toolCallResults).length === 0 || toolCallRounds.length === 0 || !invocationMessage.includes('Read')) {
		return '';
	}

	for (const roundData of toolCallRounds) {
		if (!isRecord(roundData)) {
			continue;
		}
		for (const toolCall of arrayField(roundData, 'toolCalls')) {
			if (!isRecord(toolCall) || fieldString(toolCall, 'name') !== 'read_file') {
				continue;
			}
			const toolCallId = fieldString(toolCall, 'id');
			if (typeof toolCall.arguments !== 'string') {
				continue;
			}
			let argumentsData: unknown;
			try {
				argumentsData = JSON.parse(toolCall.arguments);
			} catch {
				continue;
			}
			if (!isRecord(argumentsData)) {
				continue;
			}
			const filePath = fieldString(argumentsData, 'filePath');
			if (filePath && invocationMessage.includes(filePath) && toolCallId in toolCallResults) {
				const result = extractContentFromToolResult(toolCallResults[toolCallId]);
				if (result) {
					return result;
				}
			}
		}
	}
	return '';
}

function formatToolResultContent(
	invocationMessage: string,
	originalInvocationMessage: string,
	content: string
): string {
	const lines = ['<details>', `  <summary>${invocationMessage}</summary>`, ''];
	if (content.includes('```')) {
		lines.push('````', content.trimEnd(), '````');
	} else {
		const fileExtension = originalInvocationMessage.includes('file://')
			? /\.\w+/.exec(originalInvocationMessage)?.[0] ?? ''
			: '';
		const languages: Record<string, string> = {
			'.md': 'markdown',
			'.py': 'python',
			'.js': 'javascript',
			'.json': 'json',
			'.yaml': 'yaml',
			'.yml': 'yaml',
			'.html': 'html',
			'.css': 'css',
			'.sh': 'bash',
			'.txt': 'text',
			'.sql': 'sql'
		};
		lines.push(`\`\`\`${languages[fileExtension] ?? ''}`, content.trimEnd(), '```');
	}
	lines.push('', '</details>');
	return `${lines.join('\n')}\n\n`;
}

function formatToolInputAndOutput(invocationMessage: string, resultDetails: JsonRecord): string {
	const inputData = resultDetails.input;
	if (!isTruthy(inputData)) {
		return '';
	}

	try {
		const inputObject = typeof inputData === 'string' ? JSON.parse(inputData) as unknown : inputData;
		const inputJson = JSON.stringify(inputObject, null, 2);
		if (inputJson === undefined) {
			throw new TypeError('Tool input could not be serialized as JSON.');
		}
		const lines = [
			'<details>',
			`  <summary>${invocationMessage}</summary>`,
			'  <p>Input</p>',
			'',
			'```json',
			inputJson,
			'```',
			''
		];
		const outputData = arrayField(resultDetails, 'output');
		if (outputData.length > 0) {
			const firstOutput = outputData[0];
			const outputValue = isRecord(firstOutput)
				? fieldString(firstOutput, 'value')
				: stringValue(firstOutput);
			lines.push('  <p>Output</p>', '', '```json', outputValue, '```', '');
		}
		lines.push('</details>');
		return `${lines.join('\n')}\n\n`;
	} catch {
		return `<details>\n  <summary>${invocationMessage}</summary>\n  <p>Completed with input: ${stringValue(inputData)}</p>\n</details>\n\n`;
	}
}

function toolInvocationMessage(toolData: JsonRecord): { invocationMessage: string; originalInvocationMessage: string } {
	const pastTense = fieldString(recordField(toolData, 'pastTenseMessage'), 'value', 'Ran tool');
	const invocationValue = toolData.invocationMessage;
	let invocationMessage = isRecord(invocationValue)
		? fieldString(invocationValue, 'value', 'Ran tool')
		: stringValue(invocationValue);
	if (!invocationMessage) {
		invocationMessage = pastTense;
	}
	const originalInvocationMessage = invocationMessage;

	const fileLink = /\[\]\(file:\/\/([^)]+)(\#[^)]+)?\)/.exec(invocationMessage);
	if (fileLink) {
		const fileName = fileLink[1].split('/').at(-1) ?? fileLink[1];
		const displayName = `${fileName}${fileLink[2] ?? ''}`;
		const remainingText = invocationMessage.slice(invocationMessage.indexOf(fileLink[0]) + fileLink[0].length);
		invocationMessage = remainingText.trim()
			? `Read **${displayName}**${remainingText}`
			: `Read **${displayName}**`;
	}
	invocationMessage = invocationMessage.replaceAll('Reading ', 'Read ');

	return { invocationMessage, originalInvocationMessage };
}

function findMatchingToolCall(toolData: JsonRecord, toolCallRounds: unknown[]): JsonRecord | undefined {
	const toolCalls = toolCallRounds
		.filter(isRecord)
		.flatMap(round => arrayField(round, 'toolCalls').filter(isRecord));
	const toolCallId = fieldString(toolData, 'toolCallId');
	if (toolCallId) {
		const matchingCall = toolCalls.find(call => fieldString(call, 'id') === toolCallId);
		if (matchingCall) {
			return matchingCall;
		}
	}

	const toolId = fieldString(toolData, 'toolId');
	return toolId ? toolCalls.find(call => fieldString(call, 'name') === toolId) : undefined;
}

function formatToolInvocationSummary(toolData: JsonRecord, toolCallRounds: unknown[]): string {
	const { invocationMessage } = toolInvocationMessage(toolData);
	const matchingToolCall = findMatchingToolCall(toolData, toolCallRounds);
	const toolName = fieldString(matchingToolCall ?? {}, 'name') || fieldString(toolData, 'toolId');
	const source = recordField(toolData, 'source');
	const mcpServerName = fieldString(source, 'type') === 'mcp'
		? fieldString(source, 'serverLabel') || fieldString(source, 'label')
		: '';
	const isGenericMessage = invocationMessage.trim().toLowerCase() === 'ran tool';
	const toolNameText = isGenericMessage && toolName ? ` \`${toolName}\`` : '';
	const mcpServerText = mcpServerName ? ` - ${mcpServerName}` : '';
	return `\n▶▶ ${invocationMessage}${toolNameText}${mcpServerText}\n`;
}

function formatToolInvocationDetails(
	toolData: JsonRecord,
	toolCallResults: JsonRecord,
	toolCallRounds: unknown[]
): string {
	const { invocationMessage, originalInvocationMessage } = toolInvocationMessage(toolData);
	const toolResultContent = findReadFileResult(originalInvocationMessage, toolCallResults, toolCallRounds);
	if (toolResultContent.trim()) {
		return formatToolResultContent(invocationMessage, originalInvocationMessage, toolResultContent);
	}
	return formatToolInputAndOutput(invocationMessage, recordField(toolData, 'resultDetails'));
}

function collectMeaningfulEdits(editGroups: unknown[]): JsonRecord[] {
	const allEdits: JsonRecord[] = [];
	for (const group of editGroups) {
		if (!Array.isArray(group)) {
			continue;
		}
		for (const edit of group) {
			if (isRecord(edit) && fieldString(edit, 'text').trim()) {
				allEdits.push(edit);
			}
		}
	}
	return allEdits;
}

function editLanguage(fileName: string): string {
	const extension = /\.[^./\\]+$/.exec(fileName)?.[0] ?? '';
	return extension === '.md' ? 'markdown' : extension === '.py' ? 'python' : extension === '.json' ? 'json' : '';
}

function appendCodeBlock(lines: string[], text: string, language: string): void {
	const fence = text.includes('```') ? '````' : '```';
	lines.push(`${fence}${language}`, text.trimEnd(), fence);
}

function lineNumber(value: unknown): number {
	const number = Number(value);
	return Number.isFinite(number) ? number : 0;
}

function formatFewEdits(edits: JsonRecord[], language: string): string[] {
	const lines: string[] = [];
	if (edits.length === 1) {
		const edit = edits[0];
		const text = fieldString(edit, 'text');
		const range = recordField(edit, 'range');
		const startLine = range.startLineNumber;
		const endLine = range.endLineNumber;
		if (isTruthy(range) && isTruthy(startLine) && isTruthy(endLine)) {
			lines.push(startLine === endLine
				? `  <p><strong>Modified line ${stringValue(startLine)}:</strong></p>`
				: `  <p><strong>Modified lines ${stringValue(startLine)}-${stringValue(endLine)}:</strong></p>`, '');
		}
		appendCodeBlock(lines, text, language);
		return lines;
	}

	edits.forEach((edit, index) => {
		const text = fieldString(edit, 'text');
		const range = recordField(edit, 'range');
		const startLine = range.startLineNumber;
		const endLine = range.endLineNumber;
		if (index > 0) {
			lines.push('');
		}
		if (isTruthy(range) && isTruthy(startLine) && isTruthy(endLine)) {
			lines.push(startLine === endLine
				? `  <p><strong>Line ${stringValue(startLine)}:</strong></p>`
				: `  <p><strong>Lines ${stringValue(startLine)}-${stringValue(endLine)}:</strong></p>`, '');
		}
		appendCodeBlock(lines, text, language);
	});
	return lines;
}

function formatManyEdits(edits: JsonRecord[], language: string): string[] {
	const lines = [`  <p><strong>Multiple file changes (${edits.length} edits)</strong></p>`, ''];
	const sortedEdits = edits
		.map(edit => ({ edit, startLine: lineNumber(recordField(edit, 'range').startLineNumber) }))
		.sort((left, right) => left.startLine - right.startLine);
	const combinedContent: string[] = [];
	let index = 0;

	while (index < sortedEdits.length) {
		const current = sortedEdits[index];
		const consecutive = [current];
		let nextIndex = index + 1;
		while (nextIndex < sortedEdits.length) {
			const next = sortedEdits[nextIndex];
			const previous = consecutive[consecutive.length - 1];
			const previousRange = recordField(previous.edit, 'range');
			const previousEndLine = previousRange.endLineNumber === undefined
				? previous.startLine
				: lineNumber(previousRange.endLineNumber);
			if (next.startLine !== 0 && previousEndLine !== 0 && next.startLine <= previousEndLine + 2) {
				consecutive.push(next);
				nextIndex++;
			} else {
				break;
			}
		}

		if (consecutive.length > 1) {
			const firstLine = consecutive[0].startLine;
			const last = consecutive[consecutive.length - 1];
			const lastRange = recordField(last.edit, 'range');
			const lastLine = lastRange.endLineNumber === undefined
				? last.startLine
				: lineNumber(lastRange.endLineNumber);
			if (firstLine && lastLine) {
				combinedContent.push(`# Lines ${firstLine}-${lastLine}:`);
			}
			const combined = consecutive
				.map(item => fieldString(item.edit, 'text').trim())
				.join('\n')
				.replace(/\n\s*\n\s*\n+/g, '\n\n')
				.trim();
			if (combined) {
				combinedContent.push(combined);
			}
		} else {
			const editRange = recordField(current.edit, 'range');
			const startLine = editRange.startLineNumber;
			const endLine = editRange.endLineNumber;
			if (isTruthy(editRange) && isTruthy(startLine) && isTruthy(endLine)) {
				combinedContent.push(startLine === endLine
					? `# Line ${stringValue(startLine)}:`
					: `# Lines ${stringValue(startLine)}-${stringValue(endLine)}:`);
			} else {
				combinedContent.push(`# Edit ${index + 1}:`);
			}
			combinedContent.push(fieldString(current.edit, 'text').trimEnd());
		}

		index = nextIndex;
		if (index < sortedEdits.length) {
			combinedContent.push('');
		}
	}

	appendCodeBlock(lines, combinedContent.join('\n'), language);
	return lines;
}

function formatTextEditGroup(editData: JsonRecord): string {
	const uri = recordField(editData, 'uri');
	const filePath = fieldString(uri, 'fsPath') || fieldString(uri, 'path', 'Unknown file');
	const fileName = filePath.split(/[\\/]/).at(-1) || 'Unknown file';
	const edits = collectMeaningfulEdits(arrayField(editData, 'edits'));
	if (edits.length === 0) {
		return '';
	}

	const lines = ['<details>', `  <summary>🛠️ File Edit: ${fileName}</summary>`];
	const language = editLanguage(fileName);
	lines.push(...(edits.length <= 5
		? formatFewEdits(edits, language)
		: formatManyEdits(edits, language)));
	lines.push('', '</details>');
	return `${lines.join('\n')}\n\n`;
}

function formatProgressTask(taskData: JsonRecord): string {
	const content = recordField(taskData, 'content');
	const value = fieldString(content, 'value');
	return value ? `\n✔️ ${value}\n` : '';
}

function replaceSpecialMarkers(
	text: string,
	marker: string,
	format: (data: JsonRecord) => string
): string {
	const pattern = new RegExp(`__${marker}__(.*?)__${marker}__`, 'gs');
	return text.replace(pattern, (_match, serialized: string) => {
		let data: unknown;
		try {
			data = JSON.parse(serialized);
		} catch {
			return '';
		}
		return isRecord(data) ? format(data) : '';
	});
}

function processSpecialMarkers(
	text: string,
	toolCallResults: JsonRecord,
	toolCallRounds: unknown[],
	toolCallMode: ToolCallMode
): string {
	text = replaceSpecialMarkers(text, 'TEXT_EDIT_GROUP', formatTextEditGroup);
	text = replaceSpecialMarkers(text, 'TOOL_INVOCATION', data =>
		toolCallMode === 'omit'
			? ''
			: toolCallMode === 'summary'
				? formatToolInvocationSummary(data, toolCallRounds)
				: formatToolInvocationDetails(data, toolCallResults, toolCallRounds));
	return replaceSpecialMarkers(text, 'PROGRESS_TASK', formatProgressTask);
}

function previewForRequest(request: JsonRecord): string {
	const message = recordField(request, 'message');
	if (typeof message.text === 'string') {
		return message.text;
	}
	for (const part of arrayField(message, 'parts')) {
		if (isRecord(part) && typeof part.text === 'string') {
			return part.text;
		}
	}
	return '';
}

function messageTextForRequest(request: JsonRecord): string {
	const message = recordField(request, 'message');
	if (typeof message.text === 'string') {
		return message.text;
	}
	return arrayField(message, 'parts')
		.filter(isRecord)
		.map(part => typeof part.text === 'string' ? part.text : '')
		.join('');
}

function isToolInvocationResponsePart(part: unknown): boolean {
	if (!isRecord(part) || fieldString(part, 'kind') === 'prepareToolInvocation') {
		return false;
	}
	return fieldString(part, 'kind') === 'toolInvocationSerialized'
		|| ['invocationMessage', 'pastTenseMessage'].some(key => {
			const message = part[key];
			return isRecord(message) && 'value' in message;
		});
}

// Chat document assembly
function renderDocumentHeader(chatData: JsonRecord): string[] {
	return [
		'# GitHub Copilot Chat Log',
		'',
		`**Participant:** ${fieldString(chatData, 'requesterUsername', 'User')}`,
		`<br>**Assistant:** ${fieldString(chatData, 'responderUsername', 'GitHub Copilot')}`,
		''
	];
}

function renderTableOfContents(requests: JsonRecord[]): string[] {
	if (requests.length > 1) {
		const lines = ['<a name="table-of-contents"></a>', '## Table of Contents', ''];
		requests.forEach((request, index) => {
			const requestPreview = previewForRequest(request);
			const firstLine = requestPreview ? requestPreview.split('\n')[0] ?? '' : '[No message content]';
			const preview = firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
			lines.push(`- [Request ${index + 1}](#request-${index + 1}): ${preview}`);
		});
		lines.push('');
		return lines;
	}
	return [];
}

function renderAssistantSection(request: JsonRecord, toolCallMode: ToolCallMode): string[] {
	const response = arrayField(request, 'response');
	const result = recordField(request, 'result');
	const errorDetails = recordField(result, 'errorDetails');
	const errorMessage = fieldString(errorDetails, 'message');
	if (response.length === 0 && !errorMessage) {
		return [];
	}

	const lines = ['### Assistant', ''];
	const variables = arrayField(recordField(request, 'variableData'), 'variables');
	if (variables.length > 0) {
		const references = formatReferences(variables);
		if (references.trim()) {
			lines.push(references);
		}
	}

	if (response.length > 0) {
		let consolidatedResponse = '';
		const metadata = recordField(result, 'metadata');
		const toolCallRounds = arrayField(metadata, 'toolCallRounds');
		const hasToolInvocation = response.some(isToolInvocationResponsePart);
		const toolResponses = toolCallRounds
			.filter(isRecord)
			.map(round => round.response)
			.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
			.map(value => value.trim());
		if (toolResponses.length > 0) {
			consolidatedResponse = toolResponses.join('\n');
		}

		const responseParts = response
			.map(part => extractTextFromResponsePart(part, toolCallMode, toolCallRounds))
			.filter(part => part && part.trim());
		if (!consolidatedResponse.trim() && responseParts.length > 0) {
			consolidatedResponse = responseParts.join('\n');
		}

		if (responseParts.length > 0 || (toolCallMode !== 'full' && hasToolInvocation)) {
			const joinedResponseParts = responseParts.join('\n');
			const incrementalResponse = processSpecialMarkers(
				joinedResponseParts,
				recordField(metadata, 'toolCallResults'),
				toolCallRounds,
				toolCallMode
			);
			if (
				joinedResponseParts.includes('__TOOL_INVOCATION__')
				|| joinedResponseParts.includes('__TEXT_EDIT_GROUP__')
				|| (toolCallMode !== 'full' && hasToolInvocation)
				|| !consolidatedResponse.trim()
			) {
				consolidatedResponse = incrementalResponse;
			}
		}

		if (consolidatedResponse.trim()) {
			const cleanedResponse = formatMessageText(consolidatedResponse);
			if (cleanedResponse.trim()) {
				lines.push(cleanedResponse, '');
			}
		}
	}

	if (errorMessage) {
		const formattedError = formatErrorMessage(errorDetails);
		if (formattedError.trim()) {
			lines.push(formattedError, '');
		}
	}
	if (toolCallMode === 'omit' && lines.length === 2) {
		return [];
	}
	return lines;
}

function renderRequestMetadata(request: JsonRecord): string[] {
	const result = recordField(request, 'result');
	const lines: string[] = [];
	const timings = recordField(result, 'timings');
	if ('totalElapsed' in timings) {
		const elapsedMs = Number(timings.totalElapsed);
		if (Number.isFinite(elapsedMs)) {
			lines.push(`> *Response time: ${(elapsedMs / 1000).toFixed(2)} seconds*`);
		}
	}

	const modelId = fieldString(request, 'modelId');
	const details = fieldString(request, 'details');
	if (modelId || details) {
		const modelInfoParts: string[] = [];
		const modelDisplay = modelId.startsWith('copilot/') ? modelId.slice(8) : modelId;
		if (modelId) {
			modelInfoParts.push(modelDisplay);
		}
		if (details && details !== modelDisplay) {
			modelInfoParts.push(details);
		}
		if (modelInfoParts.length > 0) {
			lines.push(`> <br>*Model: ${modelInfoParts.join(' • ')}*`);
		}
	}
	return lines.length > 0 ? [...lines, ''] : lines;
}

function renderRequest(
	request: JsonRecord,
	index: number,
	requestCount: number,
	toolCallMode: ToolCallMode
): string[] {
	const navigation = ['[^](#table-of-contents)'];
	navigation.push(index > 1 ? `[<](#request-${index - 1})` : '<');
	navigation.push(index < requestCount ? `[>](#request-${index + 1})` : '>');
	const lines = [
		`<a name="request-${index}"></a>`,
		`## Request ${index} ${navigation.join(' ')}`,
		''
	];

	const messageText = messageTextForRequest(request);
	if (messageText) {
		lines.push('### Participant', '', formatMessageText(messageText), '');
	}
	lines.push(...renderAssistantSection(request, toolCallMode), ...renderRequestMetadata(request));
	if (index < requestCount) {
		lines.push('---', '');
	}
	return lines;
}

export function convertToMarkdown(chatData: unknown, toolCallMode: ToolCallMode = 'full'): string {
	if (!isRecord(chatData)) {
		throw new TypeError('Chat export must be a JSON object.');
	}

	const requests = arrayField(chatData, 'requests').filter(isRecord);
	const markdownLines = [
		...renderDocumentHeader(chatData),
		...renderTableOfContents(requests),
		'---',
		''
	];
	requests.forEach((request, index) => {
		markdownLines.push(...renderRequest(request, index + 1, requests.length, toolCallMode));
	});

	return markdownLines.join('\n');
}
