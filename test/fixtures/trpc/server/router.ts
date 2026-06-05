import { initTRPC } from "@trpc/server";
import { z } from "zod";

const t = initTRPC.create();
const publicProcedure = t.procedure;

// Sub-router referenced by const (cross-reference resolution).
const revenueRouter = t.router({
  today: publicProcedure.input(z.object({ storeId: z.string() })).query(() => ({})),
  range: publicProcedure.query(() => []),
});

const storeRouter = t.router({
  revenue: revenueRouter,
  detail: publicProcedure.query(() => ({})),
});

const userRouter = t.router({
  create: publicProcedure.input(z.object({ name: z.string() })).mutation(() => ({})),
  remove: publicProcedure.mutation(() => true),
  current: publicProcedure.query(() => ({})),
});

export const appRouter = t.router({
  store: storeRouter,
  user: userRouter,
  card: t.router({
    purchaseTrial: publicProcedure.mutation(() => ({})),
  }),
});

export type AppRouter = typeof appRouter;
