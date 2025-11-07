#!/bin/bash
# AI Maestro - Agent Messaging System Installer
# Installs messaging scripts and Claude Code skill

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Icons
CHECK="✅"
CROSS="❌"
INFO="ℹ️ "
WARN="⚠️ "

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                                                                ║"
echo "║           AI Maestro - Agent Messaging Installer              ║"
echo "║                                                                ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Function to print colored messages
print_success() {
    echo -e "${GREEN}${CHECK} $1${NC}"
}

print_error() {
    echo -e "${RED}${CROSS} $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}${WARN} $1${NC}"
}

print_info() {
    echo -e "${BLUE}${INFO}$1${NC}"
}

# Check if we're in the right directory
if [ ! -d "messaging_scripts" ] || [ ! -d "skills" ]; then
    print_error "Error: This script must be run from the AI Maestro root directory"
    echo ""
    echo "Usage:"
    echo "  cd /path/to/ai-maestro"
    echo "  ./install-messaging.sh"
    exit 1
fi

echo "🔍 Checking prerequisites..."
echo ""

# Track what needs to be installed
INSTALL_SCRIPTS=false
INSTALL_SKILL=false
PREREQUISITES_OK=true
TMUX_AVAILABLE=false

# Check tmux (optional for dtach-first installs)
print_info "Checking for tmux..."
if command -v tmux &> /dev/null; then
    TMUX_VERSION=$(tmux -V | cut -d' ' -f2)
    print_success "tmux installed (version $TMUX_VERSION)"
    TMUX_AVAILABLE=true
else
    print_warning "tmux not found (optional)"
    echo "         dtach-first messaging works without tmux."
    echo "         Install later with: brew install tmux"
fi

# Check if in a tmux session (legacy hooks only)
if [ -z "$TMUX" ]; then
    print_info "Not currently in a tmux session (only required for legacy tmux popups)"
fi

# Check curl
print_info "Checking for curl..."
if command -v curl &> /dev/null; then
    print_success "curl installed"
else
    print_error "curl not found (required for messaging scripts)"
    PREREQUISITES_OK=false
fi

# Check jq
print_info "Checking for jq..."
if command -v jq &> /dev/null; then
    print_success "jq installed"
else
    print_warning "jq not found (recommended but optional)"
    echo "         Install with: brew install jq"
fi

# Check Claude Code (optional)
print_info "Checking for Claude Code..."
if command -v claude &> /dev/null; then
    CLAUDE_VERSION=$(claude --version 2>/dev/null | head -n1 || echo "unknown")
    print_success "Claude Code installed ($CLAUDE_VERSION)"
    INSTALL_SKILL=true
else
    print_warning "Claude Code not found"
    echo "         Skills Mode will not be available (Manual Mode still works)"
    echo "         Install from: https://claude.ai/download"
fi

echo ""

if [ "$PREREQUISITES_OK" = false ]; then
    print_error "Missing required prerequisites. Please install them and try again."
    exit 1
fi

# Ask user what to install
echo "📦 What would you like to install?"
echo ""
echo "  1) Messaging scripts only (works with ANY agent)"
echo "  2) Claude Code skill only (requires Claude Code)"
echo "  3) Both scripts and skill (recommended)"
echo "  4) Cancel installation"
echo ""
read -p "Enter your choice (1-4): " CHOICE

case $CHOICE in
    1)
        INSTALL_SCRIPTS=true
        INSTALL_SKILL=false
        ;;
    2)
        INSTALL_SCRIPTS=false
        INSTALL_SKILL=true
        if ! command -v claude &> /dev/null; then
            print_error "Claude Code not found. Cannot install skill."
            exit 1
        fi
        ;;
    3)
        INSTALL_SCRIPTS=true
        INSTALL_SKILL=true
        if ! command -v claude &> /dev/null; then
            print_warning "Claude Code not found. Will install scripts only."
            INSTALL_SKILL=false
        fi
        ;;
    4)
        echo "Installation cancelled."
        exit 0
        ;;
    *)
        print_error "Invalid choice. Installation cancelled."
        exit 1
        ;;
esac

echo ""
echo "🚀 Starting installation..."
echo ""

# Install messaging scripts
if [ "$INSTALL_SCRIPTS" = true ]; then
    print_info "Installing messaging scripts to ~/.local/bin/..."

    # Create directory if it doesn't exist
    mkdir -p ~/.local/bin

    # Copy scripts
    SCRIPT_COUNT=0
    for script in messaging_scripts/*.sh; do
        if [ -f "$script" ]; then
            SCRIPT_NAME=$(basename "$script")
            cp "$script" ~/.local/bin/
            chmod +x ~/.local/bin/"$SCRIPT_NAME"
            print_success "Installed: $SCRIPT_NAME"
            ((SCRIPT_COUNT++))
        fi
    done

    echo ""
    print_success "Installed $SCRIPT_COUNT messaging scripts"

    # Check if ~/.local/bin is in PATH
    if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
        print_warning "~/.local/bin is not in your PATH"
        echo ""
        echo "Add this to your ~/.zshrc or ~/.bashrc:"
        echo ""
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        echo ""
        read -p "Would you like me to add it to ~/.zshrc now? (y/n): " ADD_PATH
        if [[ "$ADD_PATH" =~ ^[Yy]$ ]]; then
            echo "" >> ~/.zshrc
            echo "# AI Maestro - Added by installer" >> ~/.zshrc
            echo "export PATH=\"\$HOME/.local/bin:\$PATH\"" >> ~/.zshrc
            print_success "Added to ~/.zshrc - restart your terminal or run: source ~/.zshrc"
        else
            print_warning "Skipped PATH update - scripts may not work until PATH is configured"
        fi
    else
        print_success "~/.local/bin is already in PATH"
    fi
fi

# Install Claude Code skill
if [ "$INSTALL_SKILL" = true ]; then
    echo ""
    print_info "Installing Claude Code skill to ~/.claude/skills/..."

    # Create directory if it doesn't exist
    mkdir -p ~/.claude/skills

    # Copy skill
    if [ -d "skills/agent-messaging" ]; then
        # Remove old version if exists
        if [ -d ~/.claude/skills/agent-messaging ]; then
            print_warning "Removing old version of agent-messaging skill..."
            rm -rf ~/.claude/skills/agent-messaging
        fi

        cp -r skills/agent-messaging ~/.claude/skills/
        print_success "Installed: agent-messaging skill"

        # Verify skill file exists
        if [ -f ~/.claude/skills/agent-messaging/SKILL.md ]; then
            SKILL_SIZE=$(wc -c < ~/.claude/skills/agent-messaging/SKILL.md)
            print_success "Skill file verified (${SKILL_SIZE} bytes)"
        else
            print_error "Skill file not found after installation"
        fi
    else
        print_error "Skill source directory not found: skills/agent-messaging"
    fi
fi

echo ""
echo "🧪 Verifying installation..."
echo ""

# Verify scripts
if [ "$INSTALL_SCRIPTS" = true ]; then
    print_info "Checking installed scripts..."

    SCRIPTS_OK=true
    for script in send-aimaestro-message.sh check-and-show-messages.sh check-new-messages-arrived.sh send-tmux-message.sh; do
        if [ -x ~/.local/bin/"$script" ]; then
            print_success "$script is executable"
        else
            print_error "$script not found or not executable"
            SCRIPTS_OK=false
        fi
    done

    # Try to find scripts in PATH
    echo ""
    if command -v send-aimaestro-message.sh &> /dev/null; then
        SCRIPT_PATH=$(which send-aimaestro-message.sh)
        print_success "Scripts are accessible in PATH: $SCRIPT_PATH"
    else
        print_warning "Scripts not in PATH yet - restart terminal or run: source ~/.zshrc"
    fi

    if [ "$TMUX_AVAILABLE" = false ]; then
        print_warning "tmux not detected — legacy send-tmux-message.sh will be skipped until tmux is installed."
        echo "         This is expected for dtach-only installs; CLI messaging still works."
    fi
fi

# Verify skill
if [ "$INSTALL_SKILL" = true ]; then
    echo ""
    print_info "Checking installed skill..."

    if [ -f ~/.claude/skills/agent-messaging/SKILL.md ]; then
        print_success "agent-messaging skill is installed"

        # Check skill metadata
        if grep -q "name: AI Maestro Agent Messaging" ~/.claude/skills/agent-messaging/SKILL.md; then
            print_success "Skill metadata is valid"
        else
            print_warning "Skill metadata may be malformed"
        fi
    else
        print_error "agent-messaging skill not found"
    fi
fi

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                    Installation Complete!                      ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Show next steps
echo "📚 Next Steps:"
echo ""

if [ "$INSTALL_SCRIPTS" = true ]; then
    echo "1️⃣  Messaging Scripts (Manual Mode)"
    echo ""
    echo "   Test the scripts:"
    echo "   $ send-aimaestro-message.sh backend-architect \"Test\" \"Hello!\" normal notification"
    echo "   $ check-and-show-messages.sh"
    echo ""
    if [ "$TMUX_AVAILABLE" = true ]; then
        echo "   Legacy tmux popups:"
        echo "   $ send-tmux-message.sh \"Reminder\" \"Review the deploy plan\""
        echo ""
    else
        echo "   (tmux not installed — dtach-first installs can ignore tmux popups.)"
        echo ""
    fi
    echo "   📖 Full guide: https://github.com/23blocks-OS/ai-maestro/tree/main/messaging_scripts"
    echo ""
fi

if [ "$INSTALL_SKILL" = true ]; then
    echo "2️⃣  Claude Code Skill (Skills Mode)"
    echo ""
    echo "   In any Claude Code session, just ask:"
    echo "   > \"Send a message to backend-architect asking about the API\""
    echo ""
    echo "   Claude will automatically use the agent-messaging skill!"
    echo ""
    echo "   📖 Full guide: https://github.com/23blocks-OS/ai-maestro/tree/main/skills"
    echo ""
fi

echo "3️⃣  Documentation"
echo ""
echo "   📬 Quickstart: https://github.com/23blocks-OS/ai-maestro/blob/main/docs/AGENT-COMMUNICATION-QUICKSTART.md"
echo "   📋 Best Practices: https://github.com/23blocks-OS/ai-maestro/blob/main/docs/AGENT-COMMUNICATION-GUIDELINES.md"
echo "   📖 Complete Guide: https://github.com/23blocks-OS/ai-maestro/blob/main/docs/AGENT-MESSAGING-GUIDE.md"
echo ""
echo "   ℹ️ dtach installs: sessions will be detected via the Session Engine; tmux is optional."
echo ""
echo "4️⃣  Optional auto-check on shell start"
echo ""
echo "   Add this snippet to ~/.bashrc or ~/.zshrc to surface unread messages automatically:"
echo "   if [[ -n \"\$AIMAESTRO_SESSION\" ]] && command -v check-aimaestro-messages.sh >/dev/null; then"
echo "     check-aimaestro-messages.sh --session \"\$AIMAESTRO_SESSION\""
echo "   fi"
echo ""

# Show warnings if any
if [ "$INSTALL_SCRIPTS" = true ] && ! command -v send-aimaestro-message.sh &> /dev/null; then
    print_warning "Remember to restart your terminal or run: source ~/.zshrc"
fi

echo ""
echo "🎉 Happy agent orchestrating!"
echo ""
