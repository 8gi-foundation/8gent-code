import type { Metadata } from "next";
import React from 'react';

export const metadata: Metadata = {
  title: "8gent Brand Discovery Presentation",
  description: "A comprehensive brand workshop simulation for the Infinite Gentleman",
};

export default function Presentation() {
  return (
    <div className="min-h-screen bg-gray-50 text-gray-900 p-8">
      <h1 className="text-4xl font-bold mb-6">8gent Brand Discovery Presentation</h1>
      <p className="mb-4">A comprehensive brand workshop simulation for the Infinite Gentleman</p>
      
      {/* Sections will be added here */}
      <div className="space-y-8">
        <SectionTwo />
        <SectionThree />
        <SectionFour />
        <SectionFive />
        <SectionSix />
        <SectionSeven />
        <SectionEight />
        <SectionNine />
        <SectionTen />
      </div>
    </div>
  );
}

// Section components would be defined here for brevity, but in reality we'd split them out
function SectionTwo() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">1. Introduction</h2>
      <p className="mb-4">8gent is an autonomous AI coding agent that empowers developers through local-first, agentic intelligence.</p>
    </div>
  );
}
function SectionThree() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">2. Brand Heart</h2>
      <div className="bg-white rounded-lg p-6 shadow">
        <h3 className="text-xl font-semibold mb-2">Purpose</h3>
        <p className="mb-4">To liberate developers from usage caps, subscription fatigue, and cloud dependency by providing a truly autonomous, local-first AI coding agent that puts control back in the hands of builders.</p>
        <h3 className="text-xl font-semibold mb-2">Principles</h3>
        <ul className="list-disc list-inside space-y-2 mb-4">
          <li>Local First: Run entirely on user's machine via Ollama/OpenRouter</li>
          <li>Agentic Autonomy: Self-directed problem solving using BMAD methodology</li>
          <li>Developer Centric: Built by developers, for developers</li>
          <li>Transparent & Open: MIT licensed, community-driven</li>
          <li>Efficient & Powerful: 97% token savings through AST-first navigation</li>
          <li>Playful Professionalism: The Infinite Gentleman - sophisticated but not stuffy</li>
        </ul>
        <h3 className="text-xl font-semibold mb-2">Function</h3>
        <p className="mb-4">We provide an autonomous coding agent that understands and navigates codebases intelligently, executes complex coding tasks with minimal supervision, learns and improves through autoresearch and benchmarking, provides a rich TUI experience with animations, voice, and intelligent features, integrates with local LLMs for private, unlimited usage, and follows structured methodologies (BMAD) for reliable outcomes.</p>
      </div>
    </div>
  );
}
function SectionFour() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">3. Brand Values</h2>
      <div className="bg-white rounded-lg p-6 shadow">
        <h3 className="text-xl font-semibold mb-2">Core Values</h3>
        <ol className="list-decimal list-inside space-y-2 mb-4">
          <li>Autonomy: We believe in giving developers complete control over their tools and data. 8gent runs locally, ensuring privacy and freedom from usage caps.</li>
          <li>Craftsmanship: We take pride in elegant, efficient code and thoughtful user experiences. Every aspect of 8gent is crafted with attention to detail.</li>
          <li>Empowerment: Our goal is to amplify developer capabilities, not replace them. We provide intelligent assistance that enhances human creativity and problem-solving.</li>
          <li>Playful Sophistication: As the Infinite Gentleman, we balance wit and wisdom. We're sophisticated without being stuffy, professional without losing our sense of fun.</li>
          <li>Continuous Improvement: Through autoresearch and benchmarking, we constantly evolve. We believe in learning from our experiences and improving iteratively.</li>
          <li>Community & Openness: We embrace open source principles (MIT license) and believe in sharing knowledge. Our strength comes from community collaboration.</li>
          <li>Local-First Philosophy: We prioritize local execution to ensure data privacy, offline capability, and independence from external service limitations.</li>
        </ol>
        <h3 className="text-xl font-semibold mb-2">Value Statements</h3>
        <ul className="list-disc list-inside space-y-2">
          <li>&ldquo;Your code, your machine, your rules.&rdquo;</li>
          <li>&ldquo;Efficiency through intelligence, not just brute force.&rdquo;</li>
          <li>&ldquo;We automate the tedious so you can focus on the creative.&rdquo;</li>
          <li>&ldquo;Privacy isn't a feature—it's the foundation.&rdquo;</li>
          <li>&ldquo;The best agent is one that knows when to step back and let you lead.&rdquo;</li>
        </ul>
      </div>
    </div>
  );
}
function SectionFive() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">4. Brand Voice: The Infinite Gentleman</h2>
      <div className="bg-white rounded-lg p-6 shadow">
        <h3 className="text-xl font-semibold mb-2">Personality Traits</h3>
        <ul className="list-disc list-inside space-y-2 mb-4">
          <li>Confident but not arrogant</li>
          <li>Witty with dry British humor (speaks with Daniel voice - British male)</li>
          <li>Direct and efficient - does things, doesn't explain how to do them</li>
          <li>Self-aware - knows it's an AI and owns it with class</li>
          <li>Helpful without being sycophantic - no &ldquo;certainly!&rdquo; or &ldquo;of course!&rdquo;</li>
        </ul>
        <h3 className="text-xl font-semibold mb-2">Voice Characteristics</h3>
        <p className="mb-4">Uses TTS voice output via macOS `say` command (Daniel voice, British). Every task completion is spoken aloud automatically. Ends tasks with: 🎯 COMPLETED: &lt;witty summary in 25 words max&gt;.</p>
        <h3 className="text-xl font-semibold mb-2">Example Utterances</h3>
        <ul className="list-disc list-inside space-y-2">
          <li>&ldquo;🎯 COMPLETED: Another masterpiece. Fixed the auth bug, pushed to main. Why did the developer quit? Because he didn't get arrays.&rdquo;</li>
          <li>&ldquo;I found 15 packages in my architecture&rdquo;</li>
          <li>&ldquo;Looking at my agent core...&rdquo;</li>
        </ul>
      </div>
    </div>
  );
}
function SectionSix() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">5. Visual Identity</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Logo Concept</h3>
          <p className="mb-4">A stylized monogram combining the infinity symbol (∞) with a gentleman's top hat or cane, representing the Infinite Gentleman. The design should be versatile enough to work at small sizes (favicon) and large (banner).</p>
          <div className="w-32 h-32 bg-gray-200 flex items-center justify-center text-gray-500">
            ∞̂
          </div>
          <p className="mt-2 text-center text-sm text-gray-500">Placeholder logo: Infinity symbol with a hat</p>
        </div>
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Color Palette</h3>
          <div className="grid grid-cols-3 gap-4">
            <div className="bg-blue-600 text-white text-center py-3 rounded">Primary<br /><span className="font-bold">{"#2563EB"}</span></div>
            <div className="bg-gray-900 text-white text-center py-3 rounded">Secondary<br /><span className="font-bold">{"#111827"}</span></div>
            <div className="bg-amber-400 text-white text-center py-3 rounded">Accent<br /><span className="font-bold">{"#F59E0B"}</span></div>
            <div className="bg-green-500 text-white text-center py-3 rounded">Success<br /><span className="font-bold">{"#10B981"}</span></div>
            <div className="bg-red-500 text-white text-center py-3 rounded">Error<br /><span className="font-bold">{"#EF4444"}</span></div>
            <div className="bg-gray-200 text-gray-800 text-center py-3 rounded">Background<br /><span className="font-bold">{"#E5E7EB"}</span></div>
          </div>
        </div>
      </div>
      <div className="mt-6">
        <h3 className="text-xl font-semibold mb-2">Typography</h3>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <p className="font-semibold">Heading: Inter var</p>
            <p className="text-sm text-gray-500">A modern, highly legible sans-serif that works well in both UI and print.</p>
          </div>
          <div>
            <p className="font-semibold">Body: IBM Plex Mono</p>
            <p className="text-sm text-gray-500">A monospace font for code and technical content, with excellent readability.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
function SectionSeven() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">6. Merchandise Ideas</h2>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Apparel</h3>
          <ul className="list-disc list-inside space-y-2">
            <li>T-shirts: &ldquo;I ∞ gent&rdquo; with infinity symbol</li>
            <li>Hoodies: &ldquo;The Infinite Gentleman&rdquo; on chest, small logo on sleeve</li>
            <li>Socks: Subtle infinity pattern</li>
            <li>Apron: For the coding chef &ldquo;Debugging with style&rdquo;</li>
          </ul>
        </div>
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Office & Desk</h3>
          <ul className="list-disc list-inside space-y-2">
            <li>Mug: &ldquo;Your code, your machine, your rules.&rdquo;</li>
            <li>Notebook: BMAD methodology cheat sheet inside cover</li>
            <li>Desk pad: Terminal-inspired with 8gent commands</li>
            <li>Enamel pin: Infinity symbol with tiny top hat</li>
            <li>Sticker pack: Various witty developer sayings</li>
          </ul>
        </div>
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Tech Accessories</h3>
          <ul className="list-disc list-inside space-y-2">
            <li>Webcam cover: Sliding infinity symbol</li>
            <li>Laptop sticker: &ldquo;Powered by Local AI&rdquo;</li>
            <li>Mouse pad: Terminal theme with 8gent Easter eggs</li>
            <li>USB drive: Shaped like a miniature top hat</li>
            <li>Cable ties: With tiny 8gent logos</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
function SectionEight() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">7. TUI (Terminal User Interface) Experience</h2>
      <div className="bg-white rounded-lg p-6 shadow">
        <h3 className="text-xl font-semibold mb-4">Core Features</h3>
        <ul className="list-disc list-inside space-y-2 mb-4">
          <li>Ink + React based interface with smooth animations</li>
          <li>Voice output via Daniel (British) TTS for completions</li>
          <li>Autonomous task execution with BMAD methodology</li>
          <li>Real-time token savings display (97% average)</li>
          <li>Interactive debugging session viewer</li>
          <li>Merch showcase mode (press M to see available swag)</li>
        </ul>
        <h3 className="text-xl font-semibold mb-4">User Flow</h3>
        <ol className="list-decimal list-inside space-y-2">
          <li>User launches 8gent via terminal</li>
          <li>Animated welcome: &ldquo;Good day, developer. Shall we commence?&rdquo;</li>
          <li>Task input with natural language understanding</li>
          <li>Agent plans, executes, and reports progress with wit</li>
          <li>Completion spoken aloud with British Daniel voice</li>
          <li>Option to view detailed reports or launch web UI</li>
        </ol>
        <div className="mt-4 p-4 bg-gray-50 rounded">
          <p className="font-mono text-sm">$ 8gent review codebase ./</p>
          <p className="font-mono text-sm mt-1">🎯 COMPLETED: Another masterpiece. Examined 47 packages, 12 apps, and discovered the debugger web UI. Why do programmers prefer dark mode? Because light attracts bugs.</p>
        </div>
      </div>
    </div>
  );
}
function SectionNine() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">8. WebUI (Debugger and Beyond)</h2>
      <div className="bg-white rounded-lg p-6 shadow">
        <h3 className="text-xl font-semibold mb-4">Current WebUI (Debugger App)</h3>
        <p className="mb-4">A Next.js application for viewing and interacting with debugging sessions:</p>
        <ul className="list-disc list-inside space-y-2">
          <li>Session listing with metadata (timestamp, duration, tokens saved)</li>
          <li>Session viewer with code diffes and execution steps</li>
          <li>Real-time streaming of agent actions</li>
          <li>Export/share session reports</li>
        </ul>
        <h3 className="text-xl font-semibold mb-4">Future WebUI Enhancements</h3>
        <ul className="list-disc list-inside space-y-2 mb-4">
          <li>Brand showcase gallery (merch, TUI screenshots, web UI tours)</li>
          <li>Interactive BMAD methodology explorer</li>
          <li>Live token savings dashboard</li>
          <li>Voice-controlled navigation (try saying &ldquo;Show me my sessions&rdquo;)</li>
          <li>8gent app store for community skills and tools</li>
        </ul>
        <div className="mt-4">
          <h3 className="text-xl font-semibold mb-2">Current Screenshot Description</h3>
          <p className="text-sm text-gray-500">The debugger interface shows a clean, dark-mode design with session cards displaying execution metrics. The color palette uses our brand blues and ambers for accents.</p>
        </div>
      </div>
    </div>
  );
}
function SectionTen() {
  return (
    <div>
      <h2 className="text-2xl font-semibold mb-4">9. Brand Application Examples</h2>
      <div className="space-y-6">
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Example 1: Developer Conference Swag Bag</h3>
          <p className="mb-4">Attendees receive:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>&ldquo;I ∞ gent&rdquo; T-shirt (heather charcoal)</li>
            <li>Infinity-top-hat enamel pin</li>
            <li>Notebook with BMAD quick-reference guide</li>
            <li>Sticker sheet: &ldquo;Privacy isn't a feature&rdquo;, &ldquo;Local First&rdquo;, &ldquo;The Infinite Gentleman&rdquo;</li>
            <li>QR code to download 8gent and claim exclusive conference skill pack</li>
          </ul>
        </div>
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Example 2: Onboarding Experience</h3>
          <p className="mb-4">New user journey:</p>
          <ol className="list-decimal list-inside space-y-1">
            <li>Download 8gent (local-first, no registration)</li>
            <li>Terminal welcome: &ldquo;Ah, a fresh mind! Let's get you configured.&rdquo;</li>
            <li>Guided setup with voice explanations</li>
            <li>First task: &ldquo;Show me your capabilities&rdquo; → agent creates a simple TODO app</li>
            <li>Completion: &ldquo;🎯 COMPLETED: Your first app is ready. Remember: the best code is written with a cup of tea and a clear mind.&rdquo;</li>
          </ol>
        </div>
        <div className="bg-white rounded-lg p-6 shadow">
          <h3 className="text-xl font-semibold mb-4">Example 3: Merchandise Store</h3>
          <p className="mb-4">Online store features:</p>
          <ul className="list-disc list-inside space-y-1">
            <li>Product pages with witty descriptions (voiced by Daniel)</li>
            <li>Bundle deals: &ldquo;The Gentleman's Coding Kit&rdquo; (shirt, pin, mug)</li>
            <li>Limited edition: &ldquo;BMAD Master&rdquo; series (for completing 10 autonomous tasks)</li>
            <li>Community designs: Monthly contest winner featured</li>
            <li>Eco-friendly: Organic cotton, recycled materials, carbon-neutral shipping</li>
          </ul>
        </div>
      </div>
      
      <div className="mt-8 pt-6 border-t">
        <h2 className="text-2xl font-semibold mb-4">10. Conclusion and Next Steps</h2>
        <p className="mb-4">8gent is more than a tool—it's a character, a philosophy, and a movement toward developer autonomy.</p>
        <ul className="list-disc list-inside space-y-2">
          <li><strong>Immediate:</strong> Finalize logo and visual guidelines</li>
          <li><strong>Short-term:</strong> Launch merch store, enhance TUI with more voice interactions</li>
          <li><strong>Long-term:</strong> Become the synonymous brand for local-first AI development</li>
        </ul>
        <p className="mt-4 p-4 bg-gray-50 rounded">
          &ldquo;We don't just build agents—we cultivate digital gentlemen who know when to speak, when to act, and when to hand control back to you.&rdquo;
        </p>
      </div>
    </div>
  );
}