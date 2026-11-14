/**
 * ============================================================================
 * DYNAMIC GREETING (components/greeting/dynamic-greeting.js)
 * ============================================================================
 * Picks a time-of-day or day-of-week greeting from the bundled dictionary.
 * Rendering is synchronous, and a small localStorage memory avoids showing
 * the same line twice in a row.
 * ============================================================================
 */

class DynamicGreeting {
    constructor(target, options = {}) {
        this.container = typeof target === "string" ? document.querySelector(target) : target;
        if (!this.container) {
            throw new Error(`[DynamicGreeting] Target element not found: ${target}`);
        }

        this.options = {
            titleSelector: ".ai-header-title",
            locale: "en-US",
            refreshInterval: 30000,
            dayOverrideProbability: 0.65,
            storageKey: "artemis-dynamic-greeting",
            data: null,
            ...options
        };

        this.title = this.container.querySelector(this.options.titleSelector);
        if (!this.title) {
            throw new Error("[DynamicGreeting] Greeting title element not found.");
        }

        const data = this.options.data || {};
        this.timeGreetings = data.timeGreetings || {};
        this.dayGreetings = data.dayGreetings || {};

        this.state = {
            currentBlock: null,
            currentDay: null,
            currentGreeting: null,
            timer: null
        };

        this.renderInitial();
        this.state.timer = window.setInterval(
            () => this.update(),
            this.options.refreshInterval
        );
    }

    renderInitial() {
        const context = this.getTimeContext(new Date());
        const greeting = this.selectGreeting(context);

        this.state.currentBlock = context.block;
        this.state.currentDay = context.dayName;
        this.state.currentGreeting = greeting;

        this.getTextElement().textContent = greeting;
    }

    /**
     * Re-renders only when the time block, weekday, or selected line changes.
     */
    update(date = new Date(), options = {}) {
        const context = this.getTimeContext(date);

        const contextChanged =
            this.state.currentBlock !== context.block ||
            this.state.currentDay !== context.dayName;

        if (!contextChanged && !options.force && this.state.currentGreeting) {
            return;
        }

        const greeting = this.selectGreeting(context);
        if (greeting === this.state.currentGreeting && !options.force) {
            return;
        }

        this.state.currentBlock = context.block;
        this.state.currentDay = context.dayName;
        this.state.currentGreeting = greeting;
        this.render(greeting);
    }

    getTextElement() {
        let textEl = this.title.querySelector(".greeting__text");
        if (!textEl) {
            textEl = document.createElement("span");
            textEl.className = "greeting__text";
            this.title.appendChild(textEl);
        }
        return textEl;
    }

    render(greeting) {
        const textEl = this.getTextElement();
        const title = this.title;

        title.classList.add("ai-greeting-changing");
        window.setTimeout(() => {
            textEl.textContent = greeting;
            title.classList.remove("ai-greeting-changing");
        }, 120);
    }

    getTimeContext(date) {
        const hour = date.getHours();
        const dayName = new Intl.DateTimeFormat(
            this.options.locale,
            { weekday: "long" }
        ).format(date);

        return {
            hour,
            dayName,
            block: this.getTimeBlock(hour)
        };
    }

    getTimeBlock(hour) {
        if (hour >= 0 && hour < 2) return "midnight";
        if (hour >= 2 && hour < 4) return "deepNight";
        if (hour >= 4 && hour < 6) return "preDawn";
        if (hour >= 6 && hour < 8) return "earlyMorning";
        if (hour >= 8 && hour < 10) return "morning";
        if (hour >= 10 && hour < 12) return "lateMorning";
        if (hour >= 12 && hour < 14) return "noon";
        if (hour >= 14 && hour < 16) return "afternoon";
        if (hour >= 16 && hour < 18) return "eveningStart";
        if (hour >= 18 && hour < 20) return "evening";
        if (hour >= 20 && hour < 22) return "night";
        return "lateNight";
    }

    selectGreeting(context) {
        const dayPool = this.getDayGreetingPool(context.dayName);

        if (dayPool && dayPool.length > 0 && Math.random() < this.options.dayOverrideProbability) {
            return this.pickRandom(dayPool, `day-${context.dayName}`);
        }

        const timePool = this.timeGreetings[context.block] || this.timeGreetings.morning || [];
        return this.pickRandom(timePool, `time-${context.block}`);
    }

    getDayGreetingPool(dayName) {
        if (dayName === "Monday") return this.dayGreetings.Monday;
        if (dayName === "Wednesday") return this.dayGreetings.Wednesday;
        if (dayName === "Friday") return this.dayGreetings.Friday;
        if (dayName === "Saturday" || dayName === "Sunday") return this.dayGreetings.Weekend;
        return null;
    }

    pickRandom(pool, category) {
        if (!Array.isArray(pool) || pool.length === 0) {
            return "What are we building today?";
        }
        if (pool.length === 1) {
            return pool[0];
        }

        const storage = this.readStorage();
        const previous = storage[category] || null;

        let available = pool.filter(greeting => greeting !== previous);
        if (available.length === 0) {
            available = pool;
        }

        const index = Math.floor(Math.random() * available.length);
        const selected = available[index];

        storage[category] = selected;
        this.writeStorage(storage);

        return selected;
    }

    readStorage() {
        try {
            const raw = localStorage.getItem(this.options.storageKey);
            return raw ? JSON.parse(raw) : {};
        } catch (_) {
            return {};
        }
    }

    writeStorage(data) {
        try {
            localStorage.setItem(this.options.storageKey, JSON.stringify(data));
        } catch (_) {}
    }

    refresh() {
        this.update(new Date(), { force: true });
    }

    getCurrentGreeting() {
        return this.state.currentGreeting;
    }

    destroy() {
        if (this.state.timer) {
            window.clearInterval(this.state.timer);
            this.state.timer = null;
        }
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = DynamicGreeting;
} else {
    window.DynamicGreeting = DynamicGreeting;
}
