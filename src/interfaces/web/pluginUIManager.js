/**
 * Plugin UI Manager - Handles plugin UI integration with the web interface
 * Allows plugins to register menu items and content pages that integrate
 * seamlessly with the core UI theme and structure
 */

export class PluginUIManager {
    constructor() {
        this.pluginTabs = new Map();
        this.pluginStyles = [];
    }

    /**
     * Register a plugin's UI components
     * @param {string} pluginName - The plugin identifier
     * @param {Object} uiConfig - UI configuration from plugin.getUIConfig()
     */
    registerPlugin(pluginName, uiConfig) {
        if (!uiConfig || !uiConfig.menuItem) {
            return;
        }

        this.pluginTabs.set(pluginName, {
            menuItem: uiConfig.menuItem,
            contentLoader: uiConfig.contentLoader || null,
            initialized: false
        });
    }

    /**
     * Get all menu items (core + plugins) sorted properly
     * @param {Array} coreMenuItems - Core system menu items
     * @returns {Array} Combined and sorted menu items
     */
    getAllMenuItems(coreMenuItems) {
        const allItems = [...coreMenuItems];
        
        // Add plugin menu items
        for (const [pluginName, config] of this.pluginTabs) {
            allItems.push({
                id: pluginName,
                tab: pluginName,
                title: config.menuItem.title,
                icon: config.menuItem.icon,
                order: config.menuItem.order || 999,
                isPlugin: true
            });
        }

        // Sort by order, then by title
        return allItems.sort((a, b) => {
            if (a.order !== b.order) {
                return a.order - b.order;
            }
            return a.title.localeCompare(b.title);
        });
    }

    /**
     * Create tab content container for a plugin
     * @param {string} pluginName - Plugin identifier
     * @returns {HTMLElement} Tab content element
     */
    createPluginTabContent(pluginName) {
        const tabContent = document.createElement('div');
        tabContent.id = `${pluginName}-tab`;
        tabContent.className = 'tab-content';
        tabContent.innerHTML = `
            <div class="plugin-loading">
                <i class="fas fa-spinner fa-spin"></i>
                <p>Loading ${pluginName} interface...</p>
            </div>
        `;
        return tabContent;
    }

    /**
     * Load plugin content when tab is activated
     * @param {string} pluginName - Plugin identifier
     * @param {string} apiToken - Authentication token
     */
    async loadPluginContent(pluginName, apiToken) {
        const plugin = this.pluginTabs.get(pluginName);
        if (!plugin || plugin.initialized) {
            return;
        }

        const tabContent = document.getElementById(`${pluginName}-tab`);
        if (!tabContent) {
            return;
        }

        try {
            // Fetch plugin HTML content
            const response = await fetch(`/api/${pluginName}/ui`, {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Accept': 'text/html'
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to load plugin UI: ${response.statusText}`);
            }

            const html = await response.text();
            
            // Parse and inject content while preserving theme
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            
            // Extract and process styles to ensure theme compatibility
            const styles = doc.querySelectorAll('style');
            styles.forEach(style => {
                // Prefix plugin styles to avoid conflicts
                const prefixedStyle = this.prefixPluginStyles(style.textContent, pluginName);
                const styleElement = document.createElement('style');
                styleElement.textContent = prefixedStyle;
                document.head.appendChild(styleElement);
                this.pluginStyles.push(styleElement);
            });

            // Extract body content
            const bodyContent = doc.body.innerHTML;
            
            // Wrap content in plugin container
            tabContent.innerHTML = `
                <div class="plugin-container" data-plugin="${pluginName}">
                    ${bodyContent}
                </div>
            `;

            // Initialize any plugin scripts
            if (plugin.contentLoader) {
                await plugin.contentLoader(tabContent, apiToken);
            }

            plugin.initialized = true;

            // Dispatch event for plugin initialization
            window.dispatchEvent(new CustomEvent('pluginLoaded', {
                detail: { pluginName }
            }));

        } catch (error) {
            console.error(`Failed to load plugin ${pluginName}:`, error);
            tabContent.innerHTML = `
                <div class="error-container">
                    <i class="fas fa-exclamation-triangle"></i>
                    <h3>Failed to Load Plugin</h3>
                    <p>${error.message}</p>
                </div>
            `;
        }
    }

    /**
     * Prefix plugin styles to avoid conflicts
     * @param {string} css - Original CSS
     * @param {string} pluginName - Plugin identifier
     * @returns {string} Prefixed CSS
     */
    prefixPluginStyles(css, pluginName) {
        // Simple prefixing - in production, use a proper CSS parser
        return css.replace(/([^{]+){/g, (match, selector) => {
            // Don't prefix keyframes, media queries, or already prefixed selectors
            if (selector.includes('@') || selector.includes(`[data-plugin="${pluginName}"]`)) {
                return match;
            }
            
            // Prefix each selector
            const prefixedSelectors = selector
                .split(',')
                .map(s => `[data-plugin="${pluginName}"] ${s.trim()}`)
                .join(', ');
            
            return `${prefixedSelectors} {`;
        });
    }

    /**
     * Clean up plugin resources
     * @param {string} pluginName - Plugin identifier
     */
    unloadPlugin(pluginName) {
        const plugin = this.pluginTabs.get(pluginName);
        if (plugin) {
            // Remove tab content
            const tabContent = document.getElementById(`${pluginName}-tab`);
            if (tabContent) {
                tabContent.remove();
            }

            // Remove from registry
            this.pluginTabs.delete(pluginName);
        }
    }

    /**
     * Get standard plugin container HTML template
     * @param {string} title - Page title
     * @param {string} content - Page content
     * @returns {string} HTML template following theme
     */
    getPluginTemplate(title, content) {
        return `
            <div class="plugin-header">
                <h2>${title}</h2>
            </div>
            <div class="plugin-content">
                ${content}
            </div>
        `;
    }
}

// Export singleton instance
export const pluginUIManager = new PluginUIManager();