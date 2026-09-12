ALTER TABLE vb_accounts ADD COLUMN email_recovery jsonb;
CREATE UNIQUE INDEX vb_accounts_recovery_email ON vb_accounts ((email_recovery->>'email'))
  WHERE email_recovery->>'email' IS NOT NULL;
