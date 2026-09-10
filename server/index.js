import { onRequest } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { handleAuth } from './handler.js';
const oauthSecret = defineSecret('DIARY_GOOGLE_CLIENT_SECRET');
export const diaryAuth = onRequest(
  { region: 'asia-northeast3', secrets: [oauthSecret], maxInstances: 3 },
  (req, res) => handleAuth(req, res, { secret: oauthSecret.value() }),
);
