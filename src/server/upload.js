//
// src/server/upload.js — Multer configuration for file uploads
//
// FILES land in os.tmpdir() with a timestamped name.
// Routes read req.files (upload.array) or req.file (upload.single),
// process the temp file, then let OS clean it up naturally.
//

import multer from 'multer';
import os    from 'os';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, os.tmpdir());
  },
  filename: (_req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});
