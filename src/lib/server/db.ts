import { PrismaClient } from '@prisma/client';
const globalDb = globalThis as unknown as { cinemaDb?: PrismaClient };
export const db = globalDb.cinemaDb ?? new PrismaClient({ log: [] });
if (process.env.NODE_ENV !== 'production') globalDb.cinemaDb = db;
