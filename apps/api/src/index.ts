import 'dotenv/config';
import { createApp } from './app';
import { Env } from './config/env';

const app = createApp();

app.listen(Env.port, () => {
  console.log(`API server listening on http://localhost:${Env.port}`);
});
