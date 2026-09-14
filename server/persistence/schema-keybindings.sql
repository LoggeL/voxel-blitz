ALTER TABLE vb_accounts ADD COLUMN keybindings jsonb CHECK (keybindings IS NULL OR jsonb_typeof(keybindings) = 'object');
