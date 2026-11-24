// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { convertToMarkdown, type ToolCallMode } from './markdownConverter';

interface ToolCallModeQuickPickItem extends vscode.QuickPickItem {
	mode: ToolCallMode;
}

const toolCallModeOptions: ToolCallModeQuickPickItem[] = [
	{
		label: 'Full',
		description: 'Export full detailed tool-call output',
		mode: 'full'
	},
	{
		label: 'Tool call summary',
		description: 'Only show that a tool ran without its inputs or outputs',
		mode: 'summary'
	},
	{
		label: 'Remove tool calls',
		description: 'Omit all tool-call entries from the Markdown export',
		mode: 'omit'
	}
];

function getToolCallModeOption(mode: string): ToolCallModeQuickPickItem | undefined {
	const option = toolCallModeOptions.find(item => item.mode === mode);
	if (!option) {
		void vscode.window.showErrorMessage(
			`Invalid einwesen.chat-export-md.defaultToolCallMode setting: "${mode}". Choose Always ask, Full, Summary only, or Omit tool calls.`
		);
	}
	return option;
}

async function chooseToolCallMode(defaultMode: string): Promise<ToolCallMode | undefined> {
	const defaultOption = getToolCallModeOption(defaultMode);
	if (!defaultOption) {
		return undefined;
	}

	const choices = [defaultOption, ...toolCallModeOptions.filter(option => option !== defaultOption)];
	const selectedOption = await vscode.window.showQuickPick(choices, {
		title: 'Chat: Export Chat (Markdown)',
		placeHolder: 'Choose how tool calls appear in the export',
		ignoreFocusOut: true
	});
	return selectedOption?.mode;
}

async function readChatExport(): Promise<unknown | undefined> {
	const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
	if (!workspaceUri) {
		void vscode.window.showErrorMessage('Open a workspace folder before exporting a chat.');
		return undefined;
	}

	const outputPath = join(tmpdir(), `chat-export-${randomUUID()}.json`);
	const outputUri = workspaceUri.scheme === 'vscode-remote'
		? workspaceUri.with({ path: outputPath, query: '', fragment: '' })
		: vscode.Uri.file(outputPath);

	let operationError: unknown;
	let operationFailed = false;
	try {
		await vscode.commands.executeCommand('workbench.action.chat.export', outputUri);

		let content: Uint8Array;
		try {
			content = await vscode.workspace.fs.readFile(outputUri);
		} catch (error) {
			if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') {
				void vscode.window.showErrorMessage('No active chat was exported. Focus a Copilot Chat conversation and try again.');
				return undefined;
			}
			throw error;
		}

		let jsonData = JSON.parse(new TextDecoder().decode(content)) as unknown;
		//console.log(jsonData);
		return jsonData;
	} catch (error) {
		operationFailed = true;
		operationError = error;
		throw error;
	} finally {
		try {
			await vscode.workspace.fs.delete(outputUri, { useTrash: false });
		} catch (cleanupError) {
			if (!(cleanupError instanceof vscode.FileSystemError) || cleanupError.code !== 'FileNotFound') {
				if (operationFailed) {
					throw new AggregateError(
						[operationError, cleanupError],
						'Chat export failed and its temporary file could not be removed.'
					);
				}
				throw cleanupError;
			}
		}
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('einwesen.chat-export-md.export', async () => {
		const configuration = vscode.workspace.getConfiguration('einwesen.chat-export-md');
		const configuredMode = configuration.get<string>('defaultToolCallMode', 'alwaysAsk');
		const toolCallMode = configuredMode === 'alwaysAsk'
			? await chooseToolCallMode('summary')
			: getToolCallModeOption(configuredMode)?.mode;
		if (!toolCallMode) {
			return;
		}

		const jsonData = await readChatExport();
		if (jsonData === undefined) {
			return;
		}

		const workspaceUri = vscode.workspace.workspaceFolders?.[0]?.uri;
		if (!workspaceUri) {
			void vscode.window.showErrorMessage('Open a workspace folder before exporting a chat.');
			return;
		}

		const markdown = convertToMarkdown(jsonData, toolCallMode);
		const outputUri = await vscode.window.showSaveDialog({
			defaultUri: vscode.Uri.joinPath(workspaceUri, 'chat-export.md'),
			filters: { Markdown: ['md'] }
		});
		if (!outputUri) {
			return;
		}

		await vscode.workspace.fs.writeFile(outputUri, new TextEncoder().encode(markdown));
		void vscode.window.showInformationMessage('Chat exported as Markdown.');
	});

	context.subscriptions.push(disposable);
}

// This method is called when your extension is deactivated
export function deactivate() {}
