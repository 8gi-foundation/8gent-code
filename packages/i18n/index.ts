/**
 * 8gent Code - Internationalization / Language Support
 *
 * Allows 8gent to respond in any language.
 * The system prompt is updated to instruct the model to use the selected language.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ============================================
// Types
// ============================================

export interface LanguageConfig {
	code: string;
	name: string;
	nativeName: string;
	instruction: string;
}

export interface I18nSettings {
	activeLanguage: string;
	autoDetect: boolean;
}

// ============================================
// Supported Languages
// ============================================

export const LANGUAGES: Record<string, LanguageConfig> = {
	en: {
		code: "en",
		name: "English",
		nativeName: "English",
		instruction: "Respond in English.",
	},
	es: {
		code: "es",
		name: "Spanish",
		nativeName: "Español",
		instruction: "Responde en español.",
	},
	fr: {
		code: "fr",
		name: "French",
		nativeName: "Français",
		instruction: "Réponds en français.",
	},
	de: {
		code: "de",
		name: "German",
		nativeName: "Deutsch",
		instruction: "Antworte auf Deutsch.",
	},
	it: {
		code: "it",
		name: "Italian",
		nativeName: "Italiano",
		instruction: "Rispondi in italiano.",
	},
	pt: {
		code: "pt",
		name: "Portuguese",
		nativeName: "Português",
		instruction: "Responda em português.",
	},
	"pt-br": {
		code: "pt-br",
		name: "Brazilian Portuguese",
		nativeName: "Português Brasileiro",
		instruction: "Responda em português brasileiro.",
	},
	nl: {
		code: "nl",
		name: "Dutch",
		nativeName: "Nederlands",
		instruction: "Antwoord in het Nederlands.",
	},
	ru: {
		code: "ru",
		name: "Russian",
		nativeName: "Русский",
		instruction: "Отвечай на русском языке.",
	},
	uk: {
		code: "uk",
		name: "Ukrainian",
		nativeName: "Українська",
		instruction: "Відповідай українською мовою.",
	},
	pl: {
		code: "pl",
		name: "Polish",
		nativeName: "Polski",
		instruction: "Odpowiadaj po polsku.",
	},
	ja: {
		code: "ja",
		name: "Japanese",
		nativeName: "日本語",
		instruction: "日本語で回答してください。",
	},
	ko: {
		code: "ko",
		name: "Korean",
		nativeName: "한국어",
		instruction: "한국어로 대답해 주세요.",
	},
	zh: {
		code: "zh",
		name: "Chinese (Simplified)",
		nativeName: "简体中文",
		instruction: "请用简体中文回答。",
	},
	"zh-tw": {
		code: "zh-tw",
		name: "Chinese (Traditional)",
		nativeName: "繁體中文",
		instruction: "請用繁體中文回答。",
	},
	ar: {
		code: "ar",
		name: "Arabic",
		nativeName: "العربية",
		instruction: "أجب باللغة العربية.",
	},
	hi: {
		code: "hi",
		name: "Hindi",
		nativeName: "हिन्दी",
		instruction: "कृपया हिंदी में जवाब दें।",
	},
	th: {
		code: "th",
		name: "Thai",
		nativeName: "ไทย",
		instruction: "กรุณาตอบเป็นภาษาไทย",
	},
	vi: {
		code: "vi",
		name: "Vietnamese",
		nativeName: "Tiếng Việt",
		instruction: "Hãy trả lời bằng tiếng Việt.",
	},
	tr: {
		code: "tr",
		name: "Turkish",
		nativeName: "Türkçe",
		instruction: "Türkçe cevap ver.",
	},
	sv: {
		code: "sv",
		name: "Swedish",
		nativeName: "Svenska",
		instruction: "Svara på svenska.",
	},
	da: {
		code: "da",
		name: "Danish",
		nativeName: "Dansk",
		instruction: "Svar på dansk.",
	},
	no: {
		code: "no",
		name: "Norwegian",
		nativeName: "Norsk",
		instruction: "Svar på norsk.",
	},
	fi: {
		code: "fi",
		name: "Finnish",
		nativeName: "Suomi",
		instruction: "Vastaa suomeksi.",
	},
	he: {
		code: "he",
		name: "Hebrew",
		nativeName: "עברית",
		instruction: "ענה בעברית.",
	},
	id: {
		code: "id",
		name: "Indonesian",
		nativeName: "Bahasa Indonesia",
		instruction: "Jawab dalam Bahasa Indonesia.",
	},
	ms: {
		code: "ms",
		name: "Malay",
		nativeName: "Bahasa Melayu",
		instruction: "Jawab dalam Bahasa Melayu.",
	},
	cs: {
		code: "cs",
		name: "Czech",
		nativeName: "Čeština",
		instruction: "Odpověz česky.",
	},
	el: {
		code: "el",
		name: "Greek",
		nativeName: "Ελληνικά",
		instruction: "Απάντησε στα ελληνικά.",
	},
	ro: {
		code: "ro",
		name: "Romanian",
		nativeName: "Română",
		instruction: "Răspunde în română.",
	},
	hu: {
		code: "hu",
		name: "Hungarian",
		nativeName: "Magyar",
		instruction: "Válaszolj magyarul.",
	},
};

// ============================================
// Language Manager
// ============================================

export class LanguageManager {
	private settings: I18nSettings;
	private settingsPath: string;

	constructor(settingsPath?: string) {
		this.settingsPath =
			settingsPath || path.join(os.homedir(), ".8gent", "language.json");
		this.settings = this.loadSettings();
	}

	private loadSettings(): I18nSettings {
		try {
			if (fs.existsSync(this.settingsPath)) {
				const data = fs.readFileSync(this.settingsPath, "utf-8");
				return JSON.parse(data);
			}
		} catch (err) {
			// Ignore errors, use defaults
		}
		return {
			activeLanguage: "en",
			autoDetect: false,
		};
	}

	saveSettings(): void {
		const dir = path.dirname(this.settingsPath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		fs.writeFileSync(this.settingsPath, JSON.stringify(this.settings, null, 2));
	}

	getActiveLanguage(): LanguageConfig {
		return LANGUAGES[this.settings.activeLanguage] || LANGUAGES.en;
	}

	getLanguageCode(): string {
		return this.settings.activeLanguage;
	}

	setLanguage(code: string): boolean {
		const normalizedCode = code.toLowerCase();
		if (LANGUAGES[normalizedCode]) {
			this.settings.activeLanguage = normalizedCode;
			this.saveSettings();
			return true;
		}
		return false;
	}

	getLanguageInstruction(): string {
		const lang = this.getActiveLanguage();
		if (lang.code === "en") {
			return ""; // No special instruction needed for English
		}
		return `\n\n## Language\n${lang.instruction} Keep technical terms (code, commands, file paths) in their original form.`;
	}

	listLanguages(): LanguageConfig[] {
		return Object.values(LANGUAGES);
	}

	isValidLanguage(code: string): boolean {
		return !!LANGUAGES[code.toLowerCase()];
	}

	// For custom languages not in the preset list
	setCustomLanguage(code: string, instruction: string): void {
		this.settings.activeLanguage = code;
		// Store custom instruction (would need to extend settings)
		this.saveSettings();
	}
}

// ============================================
// Singleton & Exports
// ============================================

let languageManagerInstance: LanguageManager | null = null;

export function getLanguageManager(): LanguageManager {
	if (!languageManagerInstance) {
		languageManagerInstance = new LanguageManager();
	}
	return languageManagerInstance;
}

export function resetLanguageManager(): void {
	languageManagerInstance = null;
}

export default {
	getLanguageManager,
	resetLanguageManager,
	LANGUAGES,
};
