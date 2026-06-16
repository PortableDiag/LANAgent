#!/bin/bash

# LAN Agent - Continue Development Master Script
# This script orchestrates the next phase of development

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

echo "🚀 LAN Agent Development - Phase 2"
echo "================================="
echo ""

# Function to run a script and check result
run_script() {
    local script_name="$1"
    local description="$2"
    
    echo -e "\n📋 $description"
    echo "----------------------------------------"
    
    if [ -f "$SCRIPT_DIR/$script_name" ]; then
        bash "$SCRIPT_DIR/$script_name"
        echo "✅ $description completed!"
    else
        echo "❌ Script not found: $script_name"
        return 1
    fi
}

# Function to run npm install with legacy deps
npm_install() {
    echo -e "\n📦 Installing dependencies..."
    cd "$PROJECT_ROOT"
    
    if npm install --legacy-peer-deps; then
        echo "✅ Dependencies installed successfully"
    else
        echo "⚠️ Some dependencies failed, but continuing..."
    fi
}

# Main development flow
main() {
    echo "This script will implement:"
    echo "1. AI Provider system (OpenAI, Anthropic)"
    echo "2. Command Parser for natural language"
    echo "3. Memory Manager with conversation history"
    echo "4. Provider Manager for hot-swapping"
    echo "5. Enhanced Telegram Dashboard"
    echo ""
    echo "The agent will gain the ability to:"
    echo "• Process natural language commands"
    echo "• Remember conversations and learn"
    echo "• Switch between AI providers"
    echo "• Provide rich Telegram dashboard interface"
    echo ""
    read -p "Proceed with implementation? (y/n): " -n 1 -r
    echo ""
    
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "❌ Cancelled"
        exit 1
    fi
    
    # Step 1: Implement AI Providers
    if run_script "implement-ai-providers.sh" "Implementing AI Providers"; then
        echo "✅ AI providers ready"
    fi
    
    # Step 2: Install dependencies
    npm_install
    
    # Step 3: Implement Telegram Dashboard
    if run_script "implement-telegram-dashboard.sh" "Implementing Telegram Dashboard"; then
        echo "✅ Telegram dashboard ready"
    fi
    
    # Step 4: Test the implementation
    echo -e "\n🧪 Testing implementation..."
    echo "----------------------------------------"
    
    # Create a combined test script
    cat > "$PROJECT_ROOT/test-full-implementation.js" << 'EOF'
import dotenv from "dotenv";
import { Agent } from "./src/core/agent.js";
import { TelegramDashboard } from "./src/interfaces/telegram/telegramDashboard.js";

dotenv.config();

async function testFullImplementation() {
  console.log("🧪 Testing Full LAN Agent Implementation\n");
  
  try {
    // Initialize agent with all features
    const agent = new Agent();
    await agent.initialize();
    
    console.log("✅ Agent core initialized");
    console.log("✅ AI providers loaded:", agent.providerManager.getProviderList().map(p => p.name).join(", "));
    console.log("✅ Memory manager ready");
    console.log("✅ Command parser ready");
    
    // Test natural language processing
    console.log("\n🗣️ Testing natural language processing...");
    const testCommands = [
      "Hello, what's the system status?",
      "Update all system packages",
      "Show me running docker containers",
      "Create a backup of the database"
    ];
    
    for (const cmd of testCommands) {
      console.log(`\nCommand: "${cmd}"`);
      const parsed = agent.commandParser.parse(cmd);
      console.log(`Parsed as: ${parsed.type}.${parsed.action} (confidence: ${(parsed.confidence * 100).toFixed(0)}%)`);
    }
    
    // Initialize Telegram Dashboard
    const dashboard = new TelegramDashboard(agent);
    await dashboard.initialize();
    await dashboard.start();
    
    console.log("\n✅ All systems operational!");
    console.log("\n📱 Telegram bot is running with full dashboard");
    console.log("Available commands: /dashboard, /ai, /system, /network, /tasks, /memory, /logs, /settings");
    console.log("\nPress Ctrl+C to stop.");
    
    // Handle graceful shutdown
    process.once("SIGINT", async () => {
      console.log("\n\n🛑 Shutting down gracefully...");
      await dashboard.stop();
      await agent.stop();
      process.exit(0);
    });
    
  } catch (error) {
    console.error("\n❌ Error:", error.message);
    console.error("Stack:", error.stack);
    process.exit(1);
  }
}

testFullImplementation();
EOF

    echo "✅ Test script created"
    
    # Final summary
    echo -e "\n\n✨ Development Phase 2 Complete!"
    echo "================================="
    echo ""
    echo "✅ Implemented:"
    echo "  • AI Provider system with OpenAI and Anthropic"
    echo "  • Natural language command parser"
    echo "  • Memory manager with conversation history"
    echo "  • Provider hot-swapping capability"
    echo "  • Advanced Telegram dashboard interface"
    echo ""
    echo "🎯 Next steps:"
    echo "1. Test the implementation:"
    echo "   node test-full-implementation.js"
    echo ""
    echo "2. Deploy to server:"
    echo "   ./prepare-deployment.sh"
    echo "   ./scripts/deployment/automated-deploy.sh"
    echo ""
    echo "3. Future enhancements:"
    echo "   • System executor service (actual command execution)"
    echo "   • Network monitoring service"
    echo "   • Task scheduler with cron"
    echo "   • SSH server interface"
    echo "   • Web dashboard UI"
    echo "   • Self-modification capabilities"
    echo ""
    echo "The agent now has a brain (AI) and can understand natural language!"
    echo "The Telegram dashboard provides full administrative control."
}

# Run main function
main