import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: ['./src/core/board/schema.ts', './src/core/events/schema.ts'],
  out: './drizzle',
});
