const PIXEL_VARIANTS = {
    V0: { p: 0.4, l: 0, f: [
        [0,0,7,76,0,54,95,99,96], [34,0,4,83,0,33,95,96,81],
        [59,0,0,86,0,16,94,93,64], [77,4,0,91,0,0,94,90,44],
        [82,35,0,90,0,0,90,73,26], [85,66,7,87,0,0,83,48,8],
        [84,75,27,85,0,0,74,29,0], [84,77,57,82,0,0,60,12,0],
        [86,82,70,81,0,7,42,7,0], [87,85,77,74,0,37,24,0,0]
    ] },
    V1: { p: 0.9, l: 1, f: [
        [94,97,96,74,83,34,7,0,3], [95,97,95,88,65,14,35,0,0],
        [96,96,89,93,45,3,63,1,0], [96,95,72,95,22,0,79,21,0],
        [96,91,54,95,21,19,91,62,19], [96,81,33,95,19,19,93,79,28],
        [94,66,15,96,20,19,95,90,46], [84,43,5,95,20,22,96,95,74],
        [69,24,0,95,20,41,96,96,84], [52,7,0,93,20,63,96,97,93],
        [31,0,0,80,24,78,95,97,95], [12,0,0,60,52,90,93,97,97],
        [2,0,3,38,75,95,84,96,97], [0,0,25,20,84,95,67,95,97],
        [0,0,61,4,93,96,45,92,97], [0,12,79,0,94,97,26,76,96],
        [0,46,89,0,95,97,12,56,92], [4,73,94,0,95,96,4,37,84],
        [31,85,96,0,95,94,0,18,66], [64,93,97,0,95,89,0,5,44],
        [79,95,97,14,94,75,0,0,26], [89,97,96,45,92,59,0,0,12]
    ] },
    V2: { p: 0.4, l: 1, f: [
        [89,4,69,92,11,83,0,86,48], [92,0,89,91,63,54,4,93,12],
        [64,1,92,62,88,18,53,92,0], [20,41,92,22,95,0,80,77,0],
        [0,81,82,17,95,16,90,40,37], [0,90,45,16,88,28,92,4,78],
        [2,92,9,18,60,71,90,0,90], [48,91,0,57,16,88,69,1,94],
        [80,76,0,85,0,94,25,40,94], [89,36,26,93,0,93,1,78,83]
    ] },
    V3: { p: 0.5, l: 1, f: [
        [0,95,0,0,97,0,0,0,0], [0,68,0,0,98,0,0,0,0],
        [0,32,0,0,97,0,0,0,0], [0,10,0,0,79,0,0,0,0],
        [0,0,0,0,38,0,0,0,0], [0,0,0,0,14,0,0,0,0],
        [0,14,0,0,1,0,0,0,0], [0,59,0,0,0,0,0,0,0],
        [0,89,0,0,3,0,0,0,0], [0,94,0,0,43,0,0,0,0],
        [0,98,0,0,84,0,0,0,0], [0,98,0,0,95,0,0,0,0]
    ] },
    V4: { p: 1.12, l: 0, f: [
        [0,0,0,60,60,36,5,17,8], [0,0,0,69,88,90,0,0,0],
        [0,0,0,33,92,95,0,0,0], [0,0,0,15,87,95,0,0,0],
        [0,0,0,0,65,95,0,0,0], [0,0,0,0,19,95,0,0,0],
        [0,0,0,5,0,66,0,0,0], [0,0,0,35,0,35,0,0,0],
        [0,0,0,74,0,16,0,0,0], [0,0,0,91,27,0,0,0,0],
        [0,0,0,96,78,0,0,0,0], [0,0,0,97,89,0,0,0,0],
        [0,0,0,97,98,53,0,0,0], [0,0,0,83,98,83,0,0,0],
        [0,0,0,54,98,97,0,0,0], [0,0,0,28,97,98,0,0,0],
        [0,0,0,9,78,98,0,0,0], [0,0,0,0,31,95,0,0,0],
        [0,0,0,0,9,89,0,0,0], [0,0,0,10,0,56,0,0,0],
        [0,0,0,51,0,29,0,0,0], [0,0,0,90,5,0,0,0,0],
        [0,0,0,94,43,0,0,0,0], [0,0,0,99,85,0,0,0,0],
        [0,0,0,99,93,12,0,0,0], [0,0,0,99,98,76,0,0,0],
        [0,0,0,80,97,92,0,0,0], [0,0,0,45,97,92,0,0,0]
    ] },
    V5: { p: 1.2, l: 1, f: [
        [96,98,96,97,95,97,97,97,96], [96,97,96,97,96,96,97,96,96],
        [95,97,96,96,95,94,95,96,96], [92,93,93,93,94,91,91,92,91],
        [80,79,81,79,75,79,81,79,81], [64,62,66,64,61,64,65,63,65],
        [46,45,48,46,44,47,47,45,48], [32,32,35,33,31,33,33,33,34],
        [19,19,20,18,18,19,19,19,20], [12,12,13,12,11,12,12,12,13],
        [8,8,8,8,7,8,8,8,9], [3,2,2,2,1,2,2,2,3],
        [0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0],
        [0,0,0,0,0,0,0,0,0], [0,0,0,0,0,0,0,0,0],
        [1,1,1,1,1,1,1,1,1], [8,7,7,7,6,7,8,8,8],
        [21,20,22,20,19,22,21,21,22], [45,45,48,48,46,50,47,47,48],
        [65,63,65,64,59,63,66,64,65], [83,84,85,84,80,82,85,85,85],
        [90,92,91,92,88,90,91,92,91], [93,95,94,93,90,92,93,94,93],
        [95,98,96,95,94,95,96,96,95], [96,98,96,96,95,96,97,97,96],
        [96,98,97,96,95,96,97,97,96], [96,98,97,95,93,96,97,96,96],
        [96,98,97,95,92,97,96,96,96], [96,98,97,97,93,96,97,96,96]
    ] },
    V6: { p: 0.7, l: 1, f: [
        [0,73,0,74,93,71,0,73,0], [0,88,0,87,92,85,0,85,0],
        [0,91,0,92,87,90,0,90,0], [8,93,5,96,68,92,10,93,5],
        [54,94,52,96,23,95,55,95,52], [77,95,77,96,0,96,76,96,77],
        [87,95,88,95,0,96,88,95,88], [94,92,94,93,0,93,94,91,94],
        [97,73,96,73,0,73,96,73,96], [97,50,96,51,0,50,96,52,96],
        [96,27,96,27,0,26,96,28,96], [93,7,93,7,25,5,94,7,93],
        [89,0,89,0,59,0,90,0,90], [77,0,77,0,77,0,78,0,77],
        [50,0,49,0,86,0,50,0,49], [26,0,24,0,92,0,25,0,24],
        [14,9,12,11,93,11,15,9,12], [1,47,0,49,93,47,2,47,1]
    ] },
    V7: { p: 0.92, l: 0, f: [
        [28,42,49,25,32,42,29,41,48], [35,74,80,43,73,77,47,78,78],
        [26,80,92,47,93,98,51,97,98], [9,48,88,49,96,98,53,99,99],
        [0,11,55,31,86,96,54,99,99], [0,0,29,14,64,91,53,97,99],
        [0,0,5,0,34,86,50,96,97], [12,11,0,0,9,49,28,74,93],
        [43,46,7,0,0,13,6,36,77], [54,84,34,5,0,0,0,12,50],
        [53,93,66,25,23,0,0,0,26], [54,99,94,51,74,19,0,0,0],
        [54,99,98,53,89,60,22,18,0], [52,98,99,52,98,87,41,49,0],
        [38,93,97,51,97,98,52,81,28], [14,46,92,56,98,98,54,97,80],
        [0,21,78,44,95,98,56,98,96], [0,0,54,27,78,96,56,99,99],
        [0,0,10,0,46,89,54,98,99], [5,0,0,0,8,59,33,86,98],
        [28,26,0,0,0,30,14,59,92], [49,51,10,0,0,12,0,34,76],
        [55,94,50,13,8,0,0,0,38]
    ] },
    V8: { p: 0.6, l: 1, f: [
        [94,0,95,0,95,0,94,0,95], [94,0,95,1,95,0,94,0,95],
        [88,19,89,20,88,22,88,19,88], [63,60,64,62,59,63,63,61,64],
        [32,84,34,85,27,85,34,84,35], [11,93,12,93,7,93,13,92,13],
        [2,95,3,95,1,95,3,95,3], [0,96,0,96,0,96,0,95,0],
        [0,96,0,96,0,96,0,95,0], [6,94,7,93,3,94,7,93,7],
        [39,80,40,79,33,80,39,79,40], [75,46,76,47,73,48,76,46,76],
        [88,19,89,19,89,20,89,19,89], [93,5,93,5,94,6,92,6,93],
        [94,0,95,0,95,0,94,0,94]
    ] }
};

const PIXEL_BRAND_1 = [234,132,109,4,21,11];
const PIXEL_BRAND_2 = [231,114,109,8,10,8];
const PIXEL_BRAND_4 = [226,78,110,12,8,8];
const pixelKeyframe = (time, color) => [time, ...color];

const PIXEL_STATES = [
    { t: 0, icon: "V0", colors: [pixelKeyframe(0,PIXEL_BRAND_2), pixelKeyframe(.38,PIXEL_BRAND_1)] },
    { t: .38, icon: "V1", colors: [pixelKeyframe(0,PIXEL_BRAND_1), pixelKeyframe(2.4,PIXEL_BRAND_1), pixelKeyframe(3.67,PIXEL_BRAND_2)] },
    { t: 4.84, icon: "V2", colors: [pixelKeyframe(0,PIXEL_BRAND_4)] },
    { t: 7.26, icon: "V3", colors: [pixelKeyframe(0,PIXEL_BRAND_1), pixelKeyframe(2.2,PIXEL_BRAND_1), pixelKeyframe(3.4,PIXEL_BRAND_2)] },
    { t: 10.66, icon: "V4", colors: [pixelKeyframe(0,PIXEL_BRAND_1)] },
    { t: 11.78, icon: "V5", colors: [pixelKeyframe(0,PIXEL_BRAND_1)] },
    { t: 15.0, icon: "V6", colors: [pixelKeyframe(0,PIXEL_BRAND_2), pixelKeyframe(2.3,PIXEL_BRAND_2), pixelKeyframe(3.36,PIXEL_BRAND_4)] },
    { t: 18.36, icon: "V7", colors: [pixelKeyframe(0,PIXEL_BRAND_2)] },
    { t: 19.28, icon: "V8", colors: [pixelKeyframe(0,PIXEL_BRAND_1), pixelKeyframe(2.1,PIXEL_BRAND_1), pixelKeyframe(3.3,PIXEL_BRAND_2), pixelKeyframe(4.1,PIXEL_BRAND_2), pixelKeyframe(5.6,PIXEL_BRAND_4)] }
];

const PIXEL_LOOP_SECONDS = 27.69;

class ThinkingPixelAnimation {
    constructor() {
        this.element = document.createElement("span");
        this.element.className = "ai-thinking-pixel-loader";
        this.element.setAttribute("aria-hidden", "true");
        this.cells = Array.from({ length: 9 }, () => {
            const cell = document.createElement("i");
            this.element.appendChild(cell);
            return cell;
        });

        this.isRunning = false;
        this.frameId = null;
        this.startedAt = 0;
        this.stateIndex = -1;
        this.lastColor = null;
        this.fromColor = null;
        this.stateStartedAt = 0;
        this.reducedMotion = Boolean(
            window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches
        );
        this.frame = this.frame.bind(this);
    }

    sample(variant, time) {
        const frameCount = variant.f.length;
        let position;
        if (variant.l) {
            position = (((time % variant.p) + variant.p) % variant.p) / variant.p * frameCount;
        } else {
            position = Math.min(Math.max(time, 0) / 0.04, frameCount - 1);
        }

        const firstIndex = Math.floor(position);
        const secondIndex = variant.l
            ? (firstIndex + 1) % frameCount
            : Math.min(firstIndex + 1, frameCount - 1);
        const weight = position - firstIndex;
        const first = variant.f[firstIndex];
        const second = variant.f[secondIndex];

        return first.map((value, index) => (
            (value * (1 - weight) + second[index] * weight) / 99
        ));
    }

    colorAt(stops, time) {
        let index = 0;
        while (index < stops.length - 1 && stops[index + 1][0] <= time) index++;

        const first = stops[index];
        const second = stops[Math.min(index + 1, stops.length - 1)];
        let weight = first === second
            ? 0
            : Math.min(1, Math.max(0, (time - first[0]) / (second[0] - first[0])));
        weight = weight * weight * (3 - 2 * weight);

        return first.slice(1).map((value, offset) => (
            value + (second[offset + 1] - value) * weight
        ));
    }

    smooth(start, end, value) {
        const t = Math.min(1, Math.max(0, (value - start) / (end - start)));
        return t * t * (3 - 2 * t);
    }

    render(time, now) {
        let stateIndex = 0;
        for (let index = 0; index < PIXEL_STATES.length; index++) {
            if (PIXEL_STATES[index].t <= time) stateIndex = index;
        }

        if (stateIndex !== this.stateIndex) {
            this.stateIndex = stateIndex;
            this.fromColor = this.lastColor;
            this.stateStartedAt = now;
        }

        const state = PIXEL_STATES[stateIndex];
        const opacities = this.sample(PIXEL_VARIANTS[state.icon], time - state.t);
        let opacitySum = 0;
        this.cells.forEach((cell, index) => {
            cell.style.opacity = opacities[index].toFixed(3);
            opacitySum += opacities[index];
        });

        const color = this.colorAt(state.colors, time - state.t);
        const glow = this.smooth(0.45, 0.95, opacitySum / 9);
        let rgb = [
            color[0] + color[3] * glow,
            color[1] + color[4] * glow,
            color[2] + color[5] * glow
        ];

        if (this.fromColor) {
            const blend = this.smooth(0, 1, (now - this.stateStartedAt) / 130);
            rgb = rgb.map((value, index) => (
                this.fromColor[index] + (value - this.fromColor[index]) * blend
            ));
        }

        this.lastColor = rgb;
        const colorValue = rgb.map(Math.round).join(" ");
        this.element.style.setProperty("--pixel-color", `rgb(${colorValue})`);
        this.element.style.setProperty("--pixel-glow-1", `rgb(${colorValue} / .7)`);
        this.element.style.setProperty("--pixel-glow-2", `rgb(${colorValue} / .72)`);
        this.element.style.setProperty("--pixel-glow-3", `rgb(${colorValue} / .35)`);
    }

    start() {
        if (this.isRunning) return;
        this.isRunning = true;

        if (this.reducedMotion) {
            this.render(16.2, performance.now());
            return;
        }

        this.startedAt = performance.now();
        this.frame(performance.now());
    }

    frame(now) {
        if (!this.isRunning || this.reducedMotion) return;
        const elapsed = (now - this.startedAt) / 1000;
        this.render(elapsed % PIXEL_LOOP_SECONDS, now);
        this.frameId = requestAnimationFrame(this.frame);
    }

    stop() {
        this.isRunning = false;
        if (this.frameId !== null) cancelAnimationFrame(this.frameId);
        this.frameId = null;
    }

    getElement() {
        return this.element;
    }

    destroy() {
        this.stop();
        this.element.remove();
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = ThinkingPixelAnimation;
} else {
    window.ThinkingPixelAnimation = ThinkingPixelAnimation;
}
