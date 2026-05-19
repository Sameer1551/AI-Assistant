/**
 * @may/habit — Habit Service entry point
 */

export { HabitService, InMemoryHabitStore } from './habit-service.js';
export type {
  HabitPattern,
  LearnPatternRequest,
  PredictRequest,
  HabitPrediction,
  IHabitPatternStore,
} from './habit-service.js';
