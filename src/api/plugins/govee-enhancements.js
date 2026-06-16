// Govee Plugin Enhancements - Additional methods and UI components

export const GoveeEnhancements = {
  // Common color names to RGB values
  colorNames: {
    red: { r: 255, g: 0, b: 0 },
    green: { r: 0, g: 255, b: 0 },
    blue: { r: 0, g: 0, b: 255 },
    white: { r: 255, g: 255, b: 255 },
    black: { r: 0, g: 0, b: 0 },
    yellow: { r: 255, g: 255, b: 0 },
    cyan: { r: 0, g: 255, b: 255 },
    magenta: { r: 255, g: 0, b: 255 },
    purple: { r: 128, g: 0, b: 128 },
    violet: { r: 238, g: 130, b: 238 },
    orange: { r: 255, g: 165, b: 0 },
    pink: { r: 255, g: 192, b: 203 },
    brown: { r: 165, g: 42, b: 42 },
    gray: { r: 128, g: 128, b: 128 },
    grey: { r: 128, g: 128, b: 128 },
    lime: { r: 0, g: 255, b: 0 },
    indigo: { r: 75, g: 0, b: 130 },
    turquoise: { r: 64, g: 224, b: 208 },
    gold: { r: 255, g: 215, b: 0 },
    silver: { r: 192, g: 192, b: 192 }
  },

  // Parse color name to RGB
  parseColorName(colorName) {
    if (!colorName) return null;
    const normalized = colorName.toLowerCase().trim();
    
    // First try exact match
    if (this.colorNames[normalized]) {
      return this.colorNames[normalized];
    }
    
    // Handle compound colors like "bright white", "dark blue", etc.
    // Extract the base color by removing common modifiers
    const modifiers = ['bright', 'dark', 'light', 'deep', 'pale', 'vivid', 'warm', 'cool', 'hot'];
    for (const modifier of modifiers) {
      if (normalized.startsWith(modifier + ' ')) {
        const baseColor = normalized.substring(modifier.length + 1).trim();
        if (this.colorNames[baseColor]) {
          // For "bright" colors, we could adjust the RGB values, but for now just return base color
          return this.colorNames[baseColor];
        }
      }
    }
    
    // Also check if the color name is at the end (e.g., "make it white")
    for (const colorName of Object.keys(this.colorNames)) {
      if (normalized.endsWith(' ' + colorName) || normalized === colorName) {
        return this.colorNames[colorName];
      }
    }
    
    return null;
  },

  // Predefined themes for "surprise me" functionality
  themes: {
    relax: {
      name: 'Relaxation',
      brightness: 30,
      color: { r: 255, g: 147, b: 41 }, // Warm orange
      temperature: 2700
    },
    energize: {
      name: 'Energize', 
      brightness: 100,
      color: { r: 255, g: 255, b: 255 }, // Bright white
      temperature: 6500
    },
    romance: {
      name: 'Romance',
      brightness: 20,
      color: { r: 255, g: 0, b: 100 }, // Pink/red
      temperature: 2200
    },
    party: {
      name: 'Party',
      brightness: 80,
      scene: 'Party' // Will try to use built-in party scene
    },
    movie: {
      name: 'Movie Time',
      brightness: 15,
      color: { r: 0, g: 0, b: 255 }, // Deep blue
      temperature: 3000
    },
    sleep: {
      name: 'Sleep',
      brightness: 5,
      color: { r: 255, g: 0, b: 0 }, // Dim red
      temperature: 2000
    },
    focus: {
      name: 'Focus',
      brightness: 75,
      temperature: 5000 // Neutral white
    },
    nature: {
      name: 'Nature',
      brightness: 60,
      color: { r: 34, g: 139, b: 34 }, // Forest green
    }
  },

  // Color presets for UI
  colorPresets: [
    { name: 'Red', color: { r: 255, g: 0, b: 0 } },
    { name: 'Blue', color: { r: 0, g: 0, b: 255 } },
    { name: 'Green', color: { r: 0, g: 255, b: 0 } },
    { name: 'Yellow', color: { r: 255, g: 255, b: 0 } },
    { name: 'Purple', color: { r: 128, g: 0, b: 128 } },
    { name: 'Cyan', color: { r: 0, g: 255, b: 255 } },
    { name: 'Orange', color: { r: 255, g: 165, b: 0 } },
    { name: 'Pink', color: { r: 255, g: 192, b: 203 } },
    { name: 'White', color: { r: 255, g: 255, b: 255 } }
  ],

  // Temperature presets
  temperaturePresets: [
    { name: 'Warm White', kelvin: 2700, label: '2700K' },
    { name: 'Soft White', kelvin: 3000, label: '3000K' },
    { name: 'Neutral', kelvin: 4000, label: '4000K' },
    { name: 'Cool White', kelvin: 5000, label: '5000K' },
    { name: 'Daylight', kelvin: 6500, label: '6500K' }
  ],

  // Parse percentage from natural language
  parsePercentage(input) {
    // Match patterns like "50%", "50 percent", "fifty percent"
    const matches = input.match(/(\d+)\s*(?:%|percent)/i);
    if (matches) {
      return parseInt(matches[1]);
    }

    // Word to number mapping
    const words = {
      'ten': 10, 'twenty': 20, 'thirty': 30, 'forty': 40, 'fifty': 50,
      'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90, 'hundred': 100,
      'half': 50, 'quarter': 25, 'full': 100, 'max': 100, 'maximum': 100,
      'min': 10, 'minimum': 10, 'dim': 20, 'bright': 80, 'low': 30, 'high': 90
    };

    for (const [word, value] of Object.entries(words)) {
      if (input.toLowerCase().includes(word)) {
        return value;
      }
    }

    return null;
  },

  // Parse temperature from natural language
  parseTemperature(input) {
    if (!input) return null;
    const normalized = input.toLowerCase().trim();
    
    // Direct kelvin values like "7k", "7000k", "5000 kelvin"
    const kelvinMatch = normalized.match(/(\d+)\s*k(?:elvin)?/);
    if (kelvinMatch) {
      const kelvin = parseInt(kelvinMatch[1]);
      // If it's a single digit like "7k", multiply by 1000
      if (kelvin < 10) {
        return kelvin * 1000;
      }
      // Ensure it's within valid range
      return Math.max(2000, Math.min(9000, kelvin));
    }
    
    // Temperature descriptions
    const tempMap = {
      'warm white': 2700,
      'warm': 2700,
      'soft white': 3000,
      'soft': 3000,
      'neutral white': 4000,
      'neutral': 4000,
      'cool white': 5000,
      'cool': 5000,
      'cold white': 6500,
      'cold': 6500,
      'daylight': 6500,
      'bright white': 6500, // Bright white usually means cold/daylight
      'brightest': 6500
    };
    
    // Check for temperature keywords
    for (const [keyword, kelvin] of Object.entries(tempMap)) {
      if (normalized.includes(keyword)) {
        return kelvin;
      }
    }
    
    return null;
  },

  // Enhanced device name resolution for groups
  async resolveDeviceGroup(deviceName, deviceCache) {
    const nameLower = deviceName.toLowerCase();
    
    // Handle "all" variations
    if (nameLower === 'all' || nameLower === 'all lights' || nameLower === 'all devices' || 
        nameLower === 'everything' || nameLower === 'the whole house') {
      return Array.from(deviceCache.keys());
    }

    // Handle room-based selections
    const roomKeywords = ['kitchen', 'bedroom', 'living room', 'bathroom', 'office', 'garage', 'basement', 'hallway'];
    const matchedRoom = roomKeywords.find(room => nameLower.includes(room));
    
    if (matchedRoom) {
      const matchingDevices = [];
      for (const [deviceId, device] of deviceCache.entries()) {
        if (device.deviceName.toLowerCase().includes(matchedRoom)) {
          matchingDevices.push(deviceId);
        }
      }
      return matchingDevices.length > 0 ? matchingDevices : null;
    }

    // General pattern matching - find all devices that contain the pattern
    const matchingDevices = [];
    for (const [deviceId, device] of deviceCache.entries()) {
      if (device.deviceName.toLowerCase().includes(nameLower)) {
        matchingDevices.push(deviceId);
      }
    }
    
    return matchingDevices.length > 0 ? matchingDevices : null;
  },

  // UI Modal HTML
  getModalHTML() {
    return `
    <!-- Control Modal -->
    <div id="govee-control-modal" class="modal" style="display: none;">
      <div class="modal-content">
        <div class="modal-header">
          <h3 id="modal-title">Device Control</h3>
          <button class="modal-close" onclick="closeGoveeModal()">&times;</button>
        </div>
        <div class="modal-body" id="modal-body">
          <!-- Dynamic content will be inserted here -->
        </div>
      </div>
    </div>

    <style>
      .modal {
        position: fixed;
        z-index: 1000;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        overflow: auto;
        background-color: rgba(0,0,0,0.4);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .modal-content {
        background-color: var(--bg-secondary);
        margin: auto;
        padding: 0;
        border: 1px solid var(--border);
        border-radius: 8px;
        width: 90%;
        max-width: 500px;
        box-shadow: 0 4px 6px rgba(0,0,0,0.1);
      }
      
      .modal-header {
        padding: 20px;
        background: var(--bg-primary);
        border-bottom: 1px solid var(--border);
        display: flex;
        justify-content: space-between;
        align-items: center;
        border-radius: 8px 8px 0 0;
      }
      
      .modal-header h3 {
        margin: 0;
        color: var(--text-primary);
      }
      
      .modal-close {
        background: none;
        border: none;
        font-size: 28px;
        font-weight: bold;
        color: var(--text-secondary);
        cursor: pointer;
        padding: 0;
        width: 30px;
        height: 30px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      
      .modal-close:hover {
        color: var(--text-primary);
      }
      
      .modal-body {
        padding: 20px;
      }
      
      .color-grid {
        display: grid;
        grid-template-columns: repeat(3, 1fr);
        gap: 15px;
        margin-bottom: 20px;
      }
      
      .color-option {
        aspect-ratio: 1;
        border-radius: 8px;
        cursor: pointer;
        border: 3px solid transparent;
        transition: all 0.3s;
        position: relative;
        overflow: hidden;
      }
      
      .color-option:hover {
        transform: scale(1.05);
        border-color: var(--accent);
      }
      
      .color-option.selected {
        border-color: var(--accent);
        box-shadow: 0 0 10px rgba(var(--accent-rgb), 0.5);
      }
      
      .brightness-control, .temperature-control {
        margin: 20px 0;
      }
      
      .control-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
      }
      
      .control-header label {
        color: var(--text-primary);
        font-weight: 500;
      }
      
      .control-value {
        color: var(--accent);
        font-weight: bold;
      }
      
      .slider-container {
        position: relative;
        margin: 10px 0;
      }
      
      .control-slider {
        width: 100%;
        height: 8px;
        -webkit-appearance: none;
        appearance: none;
        background: var(--bg-primary);
        outline: none;
        opacity: 0.7;
        transition: opacity 0.2s;
        border-radius: 4px;
      }
      
      .control-slider:hover {
        opacity: 1;
      }
      
      .control-slider::-webkit-slider-thumb {
        -webkit-appearance: none;
        appearance: none;
        width: 24px;
        height: 24px;
        background: var(--accent);
        cursor: pointer;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      
      .control-slider::-moz-range-thumb {
        width: 24px;
        height: 24px;
        background: var(--accent);
        cursor: pointer;
        border-radius: 50%;
        box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      }
      
      .temperature-presets {
        display: flex;
        justify-content: space-between;
        margin-top: 10px;
      }
      
      .temp-preset {
        padding: 8px 12px;
        background: var(--bg-primary);
        color: var(--text-primary);
        border: 1px solid var(--border);
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.3s;
        font-size: 12px;
      }
      
      .temp-preset:hover {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      
      .scene-grid {
        display: grid;
        grid-template-columns: repeat(2, 1fr);
        gap: 10px;
      }
      
      .scene-option {
        padding: 15px;
        background: var(--bg-primary);
        border: 1px solid var(--border);
        border-radius: 4px;
        cursor: pointer;
        text-align: center;
        transition: all 0.3s;
      }
      
      .scene-option:hover {
        background: var(--accent);
        color: white;
        border-color: var(--accent);
      }
      
      .apply-button {
        width: 100%;
        padding: 12px;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 4px;
        font-size: 16px;
        font-weight: 500;
        cursor: pointer;
        transition: opacity 0.3s;
        margin-top: 20px;
      }
      
      .apply-button:hover {
        opacity: 0.8;
      }
      
      .apply-button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      @media (max-width: 768px) {
        .color-grid {
          grid-template-columns: repeat(2, 1fr);
        }
        .modal-content {
          width: 95%;
          max-width: none;
          margin: 10px;
          max-height: 90vh;
          overflow-y: auto;
        }
        .modal-body {
          padding: 15px;
        }
        .apply-button {
          padding: 14px;
          font-size: 18px;
          min-height: 48px;
        }
        .temp-preset {
          padding: 10px 8px;
          font-size: 14px;
        }
        .temperature-presets {
          flex-wrap: wrap;
          gap: 8px;
        }
        .control-slider {
          height: 12px;
        }
        .control-slider::-webkit-slider-thumb {
          width: 28px;
          height: 28px;
        }
        .control-slider::-moz-range-thumb {
          width: 28px;
          height: 28px;
        }
      }
    </style>
    `;
  }
};

// Group management methods
export const GroupManagement = {
  async createGroup(name, devices, description = '') {
    const { DeviceGroup } = await import('../../models/DeviceGroup.js');
    
    const group = new DeviceGroup({
      name,
      devices: devices.map(d => ({ 
        deviceId: d.deviceId || d, 
        deviceName: d.deviceName || '' 
      })),
      description,
      pluginName: 'govee'
    });
    
    await group.save();
    return group;
  },

  async getGroups() {
    const { DeviceGroup } = await import('../../models/DeviceGroup.js');
    return await DeviceGroup.find({ pluginName: 'govee' });
  },

  async getGroup(name) {
    const { DeviceGroup } = await import('../../models/DeviceGroup.js');
    return await DeviceGroup.findByName(name, 'govee');
  },

  async updateGroup(name, updates) {
    const { DeviceGroup } = await import('../../models/DeviceGroup.js');
    return await DeviceGroup.findOneAndUpdate(
      { name, pluginName: 'govee' },
      updates,
      { new: true }
    );
  },

  async deleteGroup(name) {
    const { DeviceGroup } = await import('../../models/DeviceGroup.js');
    return await DeviceGroup.findOneAndDelete({ name, pluginName: 'govee' });
  },

  async getDevicesInGroup(groupName) {
    const group = await this.getGroup(groupName);
    return group ? group.devices : [];
  }
};