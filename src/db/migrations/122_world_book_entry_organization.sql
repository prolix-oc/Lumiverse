ALTER TABLE world_book_entries ADD COLUMN folder TEXT NOT NULL DEFAULT '';
ALTER TABLE world_book_entries ADD COLUMN tags TEXT NOT NULL DEFAULT '[]';
