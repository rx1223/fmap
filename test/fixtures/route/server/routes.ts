import express from "express";

const router = express.Router();

router.get("/stores/:storeId/revenue/today", (req, res) => res.json({}));
router.get("/stores/:storeId/revenue", listRevenue);
router.post("/users", createUser);
router.delete("/users/:id", deleteUser);
router.post("/cards/trial", buyTrial);
router.get("/health", (_req, res) => res.send("ok"));

export default router;
