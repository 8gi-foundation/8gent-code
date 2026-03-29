#!/usr/bin/env bun
/**
 * SWE-bench Lite Dataset Loader
 * Fetches 300 tasks from HuggingFace, caches locally.
 */
import * as fs from "fs";
import * as path from "path";

export interface SWEBenchTask {
  instance_id: string;
  repo: string;
  base_commit: string;
  patch: string;
  test_patch: string;
  problem_statement: string;
  hints_text: string;
  created_at: string;
  version: string;
  FAIL_TO_PASS: string;
  PASS_TO_PASS: string;
}

const CACHE_DIR = path.join(process.env.HOME || "~", ".8gent", "swebench");
const CACHE_FILE = path.join(CACHE_DIR, "dataset.json");
const HF_URL =
  "https://datasets-server.huggingface.co/rows?dataset=princeton-nlp%2FSWE-bench_Lite&config=default&split=test&offset=0&length=300";

async function fetchDataset(): Promise<SWEBenchTask[]> {
  console.log("Fetching SWE-bench Lite from HuggingFace...");
  const res = await fetch(HF_URL);
  if (!res.ok) throw new Error(`HuggingFace API error: ${res.status}`);
  const data = await res.json();
  const tasks: SWEBenchTask[] = (data.rows || []).map((r: { row: SWEBenchTask }) => r.row);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(tasks, null, 2));
  console.log(`Cached ${tasks.length} tasks to ${CACHE_FILE}`);
  return tasks;
}

export async function loadTasks(subset?: number): Promise<SWEBenchTask[]> {
  let tasks: SWEBenchTask[];
  if (fs.existsSync(CACHE_FILE)) {
    console.log(`Loading cached dataset from ${CACHE_FILE}`);
    tasks = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
  } else {
    tasks = await fetchDataset();
  }
  if (!tasks.length) throw new Error("No tasks loaded");
  if (subset && subset > 0) tasks = tasks.slice(0, subset);
  console.log(`Loaded ${tasks.length} SWE-bench tasks`);
  return tasks;
}

export async function refreshDataset(): Promise<SWEBenchTask[]> {
  if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  return fetchDataset();
}
