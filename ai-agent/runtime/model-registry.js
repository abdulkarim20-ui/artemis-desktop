import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REGISTRY_PATH = path.join(__dirname, "../config/model-registry.json");

export class ModelRegistry {
    async load() {
        const raw = await fs.readFile(REGISTRY_PATH, "utf8");
        const registry = JSON.parse(raw);
        this.validateRegistry(registry);
        return registry;
    }

    async getAll() {
        const registry = await this.load();
        return registry.models;
    }

    async getDefault() {
        const registry = await this.load();
        return registry.models.find(model => model.id === registry.defaultModel) || registry.models[0] || null;
    }

    async getById(modelId) {
        if (!modelId) {
            return null;
        }
        const registry = await this.load();
        return registry.models.find(model => model.id === modelId) || null;
    }

    async resolve(input) {
        if (!input) {
            return this.getDefault();
        }
        const requestedId = typeof input === "string" ? input : input.id;
        const model = await this.getById(requestedId);
        if (!model) {
            throw new Error(`Unknown AI model: ${requestedId}`);
        }
        return model;
    }

    validateRegistry(registry) {
        if (!registry || !Array.isArray(registry.models)) {
            throw new Error("Invalid model registry: models[] is required");
        }
        const ids = new Set();
        for (const model of registry.models) {
            if (!model.id) {
                throw new Error("Model registry entry is missing id");
            }
            if (ids.has(model.id)) {
                throw new Error(`Duplicate model id: ${model.id}`);
            }
            ids.add(model.id);

            if (!model.provider) {
                throw new Error(`Model ${model.id} is missing provider`);
            }
            if (!model.model) {
                throw new Error(`Model ${model.id} is missing API model`);
            }
            if (!model.name) {
                throw new Error(`Model ${model.id} is missing display name`);
            }
            if (model.request && typeof model.request !== "object") {
                throw new Error(`Invalid request config for ${model.id}`);
            }
            if (model.imageLimits !== undefined) {
                const limits = model.imageLimits;
                const valid = limits && typeof limits === "object"
                    && ["maxImages", "maxImageBytes", "maxTotalImageBytes"].every(
                        (key) => limits[key] === undefined || (Number.isInteger(limits[key]) && limits[key] > 0)
                    );
                if (!valid) {
                    throw new Error(`Invalid imageLimits for ${model.id}`);
                }
            }
        }
    }

    /**
     * Only expose frontend-safe fields.
     * Internal request configuration remains backend-side.
     */
    toPublicModel(model) {
        return {
            id: model.id,
            provider: model.provider,
            model: model.model,
            name: model.name,
            description: model.description || "",
            providerLabel: model.providerLabel || model.provider,
            family: model.family || null,
            badge: model.badge || null,
            capabilities: model.capabilities || {},
            imageLimits: model.imageLimits || null,
        };
    }

    async getPublicRegistry() {
        const registry = await this.load();
        return {
            version: registry.version,
            defaultModel: registry.defaultModel,
            models: registry.models.map(model => this.toPublicModel(model))
        };
    }
}
