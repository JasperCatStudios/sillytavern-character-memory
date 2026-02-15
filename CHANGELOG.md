# Changelog

## 1.1.0

### New Features

- **Injected memories diagnostics**: The diagnostics panel now shows which individual memory bullets were retrieved and injected by Vector Storage during the last generation. Shows bullet count and full text.
- **Character lorebooks**: Diagnostics shows a static list of lorebooks bound to the current character, including entry counts and trigger keys for each entry.
- **Vectorization source/model**: Vectorization status now displays the configured embedding source and model (e.g., "Yes (42 chunks) via transformers/nomic-embed-text").

### Bug Fixes

- **Fix vectorization status always showing "No"**: The vector API call was missing the `source` and `model` parameters, so it couldn't find the correct vector directory. Now reads these from `extension_settings.vectors`.
- **Separate static and runtime lorebook info**: World Info section split into "Character Lorebooks" (always shows bound books) and "Activated Entries — Last Generation" (shows what fired at runtime).

## 1.0.1

### Security

- **Fix XSS in consolidation preview**: Memory bullet text, chat IDs, and dates in the consolidation Before/After preview are now escaped with `escapeHtml()` to prevent script injection from crafted memory content.
