#!/bin/sh
# Put the plugin's bin/ on PATH for this Claude Code session so `claude-agy` resolves in Bash.
if [ -n "$CLAUDE_ENV_FILE" ] && [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  printf 'export PATH="%s/bin:$PATH"\n' "$CLAUDE_PLUGIN_ROOT" >> "$CLAUDE_ENV_FILE"
fi
exit 0
