import { Router, type IRouter } from "express";
import healthRouter from "./health";
import configRouter from "./config";
import opportunitiesRouter from "./opportunities";
import tradesRouter from "./trades";
import statsRouter from "./stats";
import streamRouter from "./stream";

const router: IRouter = Router();

router.use(healthRouter);
router.use(configRouter);
router.use(opportunitiesRouter);
router.use(tradesRouter);
router.use(statsRouter);
router.use(streamRouter);

export default router;
