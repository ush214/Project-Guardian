"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.admin = exports.storage = exports.db = void 0;
// Centralized Firebase Admin initialization (TypeScript, compiled to CJS)
const firebase_admin_1 = __importDefault(require("firebase-admin"));
exports.admin = firebase_admin_1.default;
if (firebase_admin_1.default.apps.length === 0) {
    firebase_admin_1.default.initializeApp();
}
exports.db = firebase_admin_1.default.firestore();
exports.storage = firebase_admin_1.default.storage();
