# vscode-chat-export-md
This is just a small plugin mainly for my personal use.

Maybe someone els efind it usefull as well.

## Features

Adds a command to the command palette to export the copilot chat as a markdown file instead of json.

Tool-call output can be set to **Full** (include inputs and outputs), **Summary only** (show the invocation and available tool/MCP names without payloads), or **Omit tool calls**. Choose **Always ask** to select a mode for each export; **Summary only** is preselected. Configure this with `einwesen.chat-export-md.defaultToolCallMode`, which defaults to **Always ask**.


## Known Issues

None so far


## Acknowledgements

The logic for creating the markdown file was converted with Copilot from the following project:
https://github.com/peckjon/copilot-chat-to-markdown/

Thanks for the great work :)