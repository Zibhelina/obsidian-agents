export interface Skill {
  id: string;                 // no leading slash — sigil is a display concern
  label: string;              // shown in popover / chip label
  description: string;        // short subtitle in the + menu
  systemPrompt: string;       // appended to system message when active
  // Lucide icon name used in the + menu and the chip. Defaults to "sparkles"
  // if omitted.
  icon?: string;
  // Short placeholder copy shown in the editor while this skill is active
  // and the editor is empty (e.g. "Search the web" for /web). Falls back
  // to the generic "Ask anything" when omitted.
  placeholder?: string;
  // When true, the callback URL / token / session id runtime block is
  // appended to the system prompt for that turn. Skills that don't need
  // the local HTTP server don't get these fields, keeping the prompt lean.
  injectCallbackContext?: boolean;
}
