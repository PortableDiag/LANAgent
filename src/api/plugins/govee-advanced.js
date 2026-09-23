// Govee Plugin Advanced Features - Schedule/Timer backup and additional capabilities

export const GoveeAdvanced = {
  // Known device capabilities from Govee API v2
  capabilities: {
    // Basic controls
    'devices.capabilities.on_off': 'Power control',
    'devices.capabilities.range': 'Range control (brightness, humidity, etc.)',
    'devices.capabilities.color_setting': 'Color control',
    'devices.capabilities.color_temperature_setting': 'Temperature control',
    'devices.capabilities.dynamic_scene': 'Scene control',
    'devices.capabilities.music_setting': 'Music mode',
    
    // Toggle controls
    'devices.capabilities.toggle': 'Toggle switches',
    'oscillationToggle': 'Oscillation control',
    'nightlightToggle': 'Nightlight toggle',
    'airDeflectorToggle': 'Air deflector toggle',
    
    // Advanced lighting
    'devices.capabilities.segment_color_setting': 'Segment color control',
    'devices.capabilities.diy': 'DIY mode',
    'nightlightScene': 'Nightlight scenes',
    'presetScene': 'Preset scenes',
    
    // Climate/Environment controls
    'devices.capabilities.mode': 'Device modes',
    'devices.capabilities.work_mode': 'Work mode (gear, fan, auto)',
    'devices.capabilities.temperature_setting': 'Temperature setting',
    'devices.capabilities.humidity_setting': 'Humidity setting',
    
    // Device types
    'lights': 'Smart lighting',
    'air_purifiers': 'Air purification',
    'thermometers': 'Temperature monitoring',
    'sockets': 'Smart plugs/outlets',
    'sensors': 'Environmental sensors',
    'heaters': 'Heating devices',
    'humidifiers': 'Humidity control',
    'dehumidifiers': 'Dehumidification',
    'ice_makers': 'Ice making',
    'aroma_diffusers': 'Aroma diffusion'
  },
  
  // Device type detection
  getDeviceType(model, deviceName) {
    const name = deviceName.toLowerCase();
    const modelUpper = model.toUpperCase();
    
    // Check common patterns
    if (modelUpper.startsWith('H5') || name.includes('plug') || name.includes('outlet')) {
      return 'socket';
    } else if (modelUpper.startsWith('H7')) {
      // H7 series are often appliances
      if (name.includes('purifier') || name.includes('air')) return 'air_purifier';
      if (name.includes('humidifier')) return 'humidifier';
      if (name.includes('heater')) return 'heater';
    } else if (name.includes('thermo')) {
      return 'thermometer';
    } else if (name.includes('sensor')) {
      return 'sensor';
    }
    
    // Default to light
    return 'light';
  },
  
  // Parse device state to extract all settings including timers/schedules
  extractDeviceSettings(deviceState) {
    const settings = {
      deviceId: deviceState.device,
      deviceName: deviceState.deviceName,
      timestamp: new Date().toISOString(),
      capabilities: {}
    };
    
    // Extract all capability states
    if (deviceState.capabilities) {
      deviceState.capabilities.forEach(cap => {
        settings.capabilities[cap.instance] = {
          type: cap.type,
          value: cap.value,
          lastUpdate: cap.lastUpdate
        };
      });
    }
    
    return settings;
  },
  
  // Create a backup of all device settings
  createBackup(devices) {
    return {
      version: '1.0',
      timestamp: new Date().toISOString(),
      deviceCount: devices.length,
      devices: devices.map(device => this.extractDeviceSettings(device))
    };
  },
  
  // Generate restore commands from backup
  generateRestoreCommands(backup, targetDevices) {
    const commands = [];
    
    backup.devices.forEach(backedUpDevice => {
      // Find matching device in current devices
      const currentDevice = targetDevices.find(d => 
        d.device === backedUpDevice.deviceId || 
        d.deviceName === backedUpDevice.deviceName
      );
      
      if (currentDevice) {
        // Generate commands for each capability
        Object.entries(backedUpDevice.capabilities).forEach(([instance, capData]) => {
          // Skip online status and read-only capabilities
          if (instance === 'online' || instance === 'wifiSoftwareVersion') return;
          
          commands.push({
            device: currentDevice.device,
            capability: capData.type,
            instance: instance,
            value: capData.value,
            deviceName: currentDevice.deviceName
          });
        });
      }
    });
    
    return commands;
  },
  
  // Format backup for display
  formatBackupSummary(backup) {
    const summary = [`Govee Settings Backup (${backup.timestamp})`];
    summary.push(`Devices: ${backup.deviceCount}`);
    summary.push('');
    
    backup.devices.forEach(device => {
      summary.push(`📱 ${device.deviceName}`);
      Object.entries(device.capabilities).forEach(([instance, cap]) => {
        if (instance !== 'online') {
          summary.push(`  - ${instance}: ${JSON.stringify(cap.value)}`);
        }
      });
      summary.push('');
    });
    
    return summary.join('\\n');
  },
  
  // Get advanced features UI
  getAdvancedFeaturesUI() {
    return `
    <div class="settings-card" style="margin-bottom: 20px;">
        <h3>Advanced Features</h3>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; margin-top: 15px;">
            <button class="govee-button" onclick="backupAllSettings()">
                <i class="fas fa-download"></i> Backup All Settings
            </button>
            <button class="govee-button" onclick="showRestoreModal()">
                <i class="fas fa-upload"></i> Restore Settings
            </button>
            <button class="govee-button" onclick="showDeviceCapabilities()">
                <i class="fas fa-info-circle"></i> Device Capabilities
            </button>
            <button class="govee-button" onclick="refreshAllStates()">
                <i class="fas fa-sync"></i> Refresh All States
            </button>
        </div>
    </div>
    `;
  },
  
  // Get JavaScript for advanced features
  getAdvancedJS() {
    return `
    // Advanced features
    window.backupAllSettings = async function() {
        try {
            // Get current state of all devices
            const statesPromises = devices.map(device => 
                fetchWithAuth('/api/govee/device/' + encodeURIComponent(device.device) + '/status?sku=' + encodeURIComponent(device.sku))
                    .then(r => r.json())
                    .then(data => data.success ? data : null)
            );
            
            const states = await Promise.all(statesPromises);
            const validStates = states.filter(s => s !== null);
            
            const backup = {
                version: '1.0',
                timestamp: new Date().toISOString(),
                deviceCount: validStates.length,
                devices: validStates
            };
            
            // Download as JSON file
            const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'govee-backup-' + new Date().toISOString().split('T')[0] + '.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: 'Backup saved successfully', type: 'success' }
            }));
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: 'Backup failed: ' + error.message, type: 'error' }
            }));
        }
    };
    
    window.showRestoreModal = function() {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = 'Restore Settings';
        
        body.innerHTML = \`
            <div style="text-align: center; padding: 20px;">
                <p style="margin-bottom: 20px; color: var(--text-secondary);">
                    Select a backup file to restore device settings
                </p>
                <input type="file" id="restore-file-input" accept=".json" style="margin-bottom: 20px;">
                <div id="restore-preview" style="margin-bottom: 20px;"></div>
                <button class="apply-button" onclick="performRestore()" id="restore-button" disabled>
                    Restore Settings
                </button>
            </div>
        \`;
        
        document.getElementById('restore-file-input').addEventListener('change', handleRestoreFileSelect);
        modal.style.display = 'flex';
    };
    
    window.handleRestoreFileSelect = async function(event) {
        const file = event.target.files[0];
        if (!file) return;
        
        try {
            const text = await file.text();
            const backup = JSON.parse(text);
            
            // Validate backup
            if (!backup.version || !backup.devices) {
                throw new Error('Invalid backup file format');
            }
            
            window.pendingRestore = backup;
            
            // Show preview
            const preview = document.getElementById('restore-preview');
            preview.innerHTML = \`
                <div style="background: var(--bg-primary); padding: 15px; border-radius: 8px; text-align: left;">
                    <strong>Backup Details:</strong><br>
                    Date: \${new Date(backup.timestamp).toLocaleString()}<br>
                    Devices: \${backup.deviceCount}<br>
                    <br>
                    <strong style="color: var(--warning);">⚠️ Warning:</strong> This will overwrite current settings!
                </div>
            \`;
            
            document.getElementById('restore-button').disabled = false;
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: 'Invalid backup file: ' + error.message, type: 'error' }
            }));
        }
    };
    
    window.performRestore = async function() {
        if (!window.pendingRestore) return;
        
        const button = document.getElementById('restore-button');
        button.disabled = true;
        button.textContent = 'Restoring...';
        
        try {
            const response = await fetchWithAuth('/api/govee/restore', {
                method: 'POST',
                body: JSON.stringify({ backup: window.pendingRestore })
            });
            
            const data = await response.json();
            if (data.success) {
                window.dispatchEvent(new CustomEvent('showToast', {
                    detail: { 
                        message: \`Restored \${data.restoredCount} settings successfully\`, 
                        type: 'success' 
                    }
                }));
                closeGoveeModal();
                setTimeout(loadDevices, 2000);
            } else {
                throw new Error(data.error || 'Restore failed');
            }
        } catch (error) {
            window.dispatchEvent(new CustomEvent('showToast', {
                detail: { message: error.message, type: 'error' }
            }));
            button.disabled = false;
            button.textContent = 'Restore Settings';
        }
    };
    
    window.showDeviceCapabilities = async function() {
        const modal = document.getElementById('govee-control-modal');
        const title = document.getElementById('modal-title');
        const body = document.getElementById('modal-body');
        
        title.textContent = 'Device Capabilities';
        body.innerHTML = '<div class="loading">Loading capabilities...</div>';
        modal.style.display = 'flex';
        
        try {
            const capabilitiesMap = new Map();
            
            // Collect all unique capabilities
            devices.forEach(device => {
                if (device.capabilities) {
                    device.capabilities.forEach(cap => {
                        if (!capabilitiesMap.has(cap)) {
                            capabilitiesMap.set(cap, []);
                        }
                        capabilitiesMap.get(cap).push(device.deviceName);
                    });
                }
            });
            
            // Display capabilities
            body.innerHTML = \`
                <div style="max-height: 400px; overflow-y: auto;">
                    \${Array.from(capabilitiesMap.entries()).map(([cap, deviceNames]) => \`
                        <div style="margin-bottom: 15px; padding: 10px; background: var(--bg-primary); border-radius: 4px;">
                            <strong>\${cap}</strong>
                            <div style="color: var(--text-secondary); font-size: 12px; margin-top: 5px;">
                                Devices: \${deviceNames.length} - \${deviceNames.slice(0, 3).join(', ')}\${deviceNames.length > 3 ? '...' : ''}
                            </div>
                        </div>
                    \`).join('')}
                </div>
            \`;
        } catch (error) {
            body.innerHTML = '<div class="error">Failed to load capabilities</div>';
        }
    };
    
    window.refreshAllStates = async function() {
        window.dispatchEvent(new CustomEvent('showToast', {
            detail: { message: 'Refreshing all device states...', type: 'info' }
        }));
        
        await loadDevices();
        
        window.dispatchEvent(new CustomEvent('showToast', {
            detail: { message: 'Device states refreshed', type: 'success' }
        }));
    };
    `;
  }
};

// Schedule management using Agenda
export const ScheduleManagement = {
  // List all schedules for a device or all devices
  async listSchedules(deviceId = null) {
    try {
      const Agenda = (await import('agenda')).default;
      const agenda = new Agenda({
        db: { address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent' }
      });
      
      await agenda.start();
      
      // Build query
      const query = { 'data.plugin': 'govee' };
      if (deviceId) {
        query['data.deviceId'] = deviceId;
      }
      
      const jobs = await agenda.jobs(query);
      
      const schedules = jobs.map(job => ({
        id: job.attrs._id.toString(),
        name: job.attrs.name,
        deviceId: job.attrs.data.deviceId,
        deviceName: job.attrs.data.deviceName,
        action: job.attrs.data.action,
        value: job.attrs.data.value,
        time: job.attrs.data.time,
        repeat: job.attrs.repeatInterval,
        nextRunAt: job.attrs.nextRunAt,
        lastRunAt: job.attrs.lastRunAt,
        disabled: job.attrs.disabled || false
      }));
      
      await agenda.stop();
      return schedules;
    } catch (error) {
      throw new Error(`Failed to list schedules: ${error.message}`);
    }
  },

  // Create a new schedule
  async createSchedule(params) {
    try {
      const Agenda = (await import('agenda')).default;
      const agenda = new Agenda({
        db: { address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent' }
      });
      
      await agenda.start();
      
      // Create job name
      const jobName = `govee-${params.deviceName}-${params.action}-${Date.now()}`;
      
      // Define the job
      agenda.define(jobName, async (job) => {
        const { plugin } = await import('../plugins/govee.js');
        const goveePlugin = plugin;
        
        // Execute the action
        switch (job.attrs.data.action) {
          case 'on':
            await goveePlugin.setPower({ device: job.attrs.data.deviceId, state: 'on' });
            break;
          case 'off':
            await goveePlugin.setPower({ device: job.attrs.data.deviceId, state: 'off' });
            break;
          case 'brightness':
            await goveePlugin.setBrightness({ 
              device: job.attrs.data.deviceId, 
              level: job.attrs.data.value 
            });
            break;
          case 'color':
            await goveePlugin.setColor({
              device: job.attrs.data.deviceId,
              ...job.attrs.data.value
            });
            break;
          case 'scene':
            await goveePlugin.setScene({
              device: job.attrs.data.deviceId,
              scene: job.attrs.data.value
            });
            break;
        }
      });
      
      // Create the job
      const job = agenda.create(jobName, {
        plugin: 'govee',
        deviceId: params.deviceId,
        deviceName: params.deviceName,
        action: params.action,
        value: params.value,
        time: params.time
      });
      
      // Set schedule
      if (params.repeat === 'once') {
        job.schedule(params.time);
      } else if (params.repeat === 'daily') {
        job.repeatEvery('1 day', { timezone: 'America/New_York' });
        job.schedule(params.time);
      } else if (params.repeat === 'weekdays') {
        job.repeatEvery('1 day', { 
          timezone: 'America/New_York',
          skipDays: ['Saturday', 'Sunday'] 
        });
        job.schedule(params.time);
      } else if (params.repeat === 'weekends') {
        job.repeatEvery('1 day', { 
          timezone: 'America/New_York',
          skipDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] 
        });
        job.schedule(params.time);
      } else if (params.repeat === 'custom' && params.days) {
        job.repeatEvery('1 day', { 
          timezone: 'America/New_York',
          skipDays: this.getSkipDays(params.days)
        });
        job.schedule(params.time);
      }
      
      if (!params.enabled) {
        job.disable();
      }
      
      await job.save();
      await agenda.stop();
      
      return {
        id: job.attrs._id.toString(),
        name: jobName,
        deviceId: params.deviceId,
        deviceName: params.deviceName,
        action: params.action,
        time: params.time,
        repeat: params.repeat
      };
    } catch (error) {
      throw new Error(`Failed to create schedule: ${error.message}`);
    }
  },

  // Update an existing schedule
  async updateSchedule(scheduleId, updates) {
    try {
      const Agenda = (await import('agenda')).default;
      const { ObjectId } = await import('mongodb');
      const agenda = new Agenda({
        db: { address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent' }
      });

      await agenda.start();

      // Convert string ID to ObjectId for MongoDB query
      const queryId = typeof scheduleId === 'string' ? new ObjectId(scheduleId) : scheduleId;
      const jobs = await agenda.jobs({ _id: queryId });
      if (jobs.length === 0) {
        throw new Error('Schedule not found');
      }
      
      const job = jobs[0];
      
      // Update job data
      if (updates.time) {
        job.schedule(updates.time);
      }
      if (updates.enabled !== undefined) {
        if (updates.enabled) {
          job.enable();
        } else {
          job.disable();
        }
      }
      if (updates.repeat) {
        // Update repeat interval
        if (updates.repeat === 'once') {
          job.attrs.repeatInterval = null;
        } else if (updates.repeat === 'daily') {
          job.repeatEvery('1 day', { timezone: 'America/New_York' });
        } else if (updates.repeat === 'weekdays') {
          job.repeatEvery('1 day', {
            timezone: 'America/New_York',
            skipDays: ['Saturday', 'Sunday']
          });
        } else if (updates.repeat === 'weekends') {
          job.repeatEvery('1 day', {
            timezone: 'America/New_York',
            skipDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']
          });
        } else if (updates.repeat === 'custom' && updates.days) {
          job.repeatEvery('1 day', {
            timezone: 'America/New_York',
            skipDays: this.getSkipDays(updates.days)
          });
        }
      }
      if (updates.action) {
        job.attrs.data.action = updates.action;
      }
      if (updates.value !== undefined) {
        job.attrs.data.value = updates.value;
      }

      await job.save();
      await agenda.stop();
      
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to update schedule: ${error.message}`);
    }
  },

  // Delete a schedule
  async deleteSchedule(scheduleId) {
    try {
      const Agenda = (await import('agenda')).default;
      const { ObjectId } = await import('mongodb');
      const agenda = new Agenda({
        db: { address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent' }
      });

      await agenda.start();
      // Convert string ID to ObjectId for MongoDB query
      const queryId = typeof scheduleId === 'string' ? new ObjectId(scheduleId) : scheduleId;
      await agenda.cancel({ _id: queryId });
      await agenda.stop();
      
      return { success: true };
    } catch (error) {
      throw new Error(`Failed to delete schedule: ${error.message}`);
    }
  },

  // Helper function to get skip days
  getSkipDays(selectedDays) {
    const allDays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return allDays.filter(day => !selectedDays.includes(day));
  },

  // Create a schedule backup
  async backupSchedules() {
    try {
      const Agenda = (await import('agenda')).default;
      const agenda = new Agenda({
        db: { address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent' }
      });
      
      await agenda.start();
      
      // Get all Govee-related jobs
      const jobs = await agenda.jobs({ 'data.plugin': 'govee' });
      
      const backup = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        schedules: jobs.map(job => ({
          name: job.attrs.name,
          data: job.attrs.data,
          repeatInterval: job.attrs.repeatInterval,
          nextRunAt: job.attrs.nextRunAt,
          disabled: job.attrs.disabled
        }))
      };
      
      await agenda.stop();
      return backup;
    } catch (error) {
      throw new Error(`Failed to backup schedules: ${error.message}`);
    }
  },
  
  // Restore schedules from backup
  async restoreSchedules(backup) {
    try {
      const Agenda = (await import('agenda')).default;
      const agenda = new Agenda({
        db: { address: process.env.MONGODB_URI || 'mongodb://localhost:27017/lanagent' }
      });
      
      await agenda.start();
      
      // Remove existing Govee schedules
      await agenda.cancel({ 'data.plugin': 'govee' });
      
      // Restore each schedule
      for (const schedule of backup.schedules) {
        const job = agenda.create(schedule.name, schedule.data);
        if (schedule.repeatInterval) {
          job.repeatEvery(schedule.repeatInterval);
        }
        if (schedule.disabled) {
          job.disable();
        }
        await job.save();
      }
      
      await agenda.stop();
      return { success: true, restoredCount: backup.schedules.length };
    } catch (error) {
      throw new Error(`Failed to restore schedules: ${error.message}`);
    }
  }
};