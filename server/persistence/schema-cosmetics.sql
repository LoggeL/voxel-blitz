-- Migration 2: new attribution starts at zero for historical careers.
-- Keep version 1 unchanged so deployed databases can verify its checksum.
ALTER TABLE vb_careers ADD COLUMN pvp_kills bigint NOT NULL DEFAULT 0 CHECK (pvp_kills BETWEEN 0 AND 9007199254740991);
ALTER TABLE vb_careers ADD COLUMN wins bigint NOT NULL DEFAULT 0 CHECK (wins BETWEEN 0 AND 9007199254740991);
ALTER TABLE vb_careers ADD COLUMN mastery jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(mastery) = 'object');
