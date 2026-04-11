// Check VPN settings in database using MongoDB shell command
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function checkVPNSettings() {
  try {
    console.log('🔍 Checking VPN settings in MongoDB...\n');
    
    // Use mongo shell to query the database
    const query = 'db.pluginsettings.findOne({pluginName: "vpn", settingsKey: "config"})';
    const command = `mongosh lanagent --quiet --eval '${query}'`;
    
    const { stdout, stderr } = await execAsync(command);
    
    if (stderr) {
      console.error('Error:', stderr);
      return;
    }
    
    if (stdout.trim()) {
      console.log('Current VPN settings in database:');
      console.log(stdout);
    } else {
      console.log('No VPN settings found in database');
    }
    
    // Also check for any plugin settings
    console.log('\n🔍 All plugin settings:');
    const allQuery = 'db.pluginsettings.find().pretty()';
    const allCommand = `mongosh lanagent --quiet --eval '${allQuery}'`;
    
    const { stdout: allStdout } = await execAsync(allCommand);
    if (allStdout.trim()) {
      console.log(allStdout);
    } else {
      console.log('No plugin settings found');
    }
    
  } catch (error) {
    if (error.code === 127) {
      console.log('MongoDB shell (mongosh) not found. Trying legacy mongo command...');
      try {
        const command = `mongo lanagent --quiet --eval 'db.pluginsettings.findOne({pluginName: "vpn", settingsKey: "config"})'`;
        const { stdout } = await execAsync(command);
        console.log('Current VPN settings:', stdout || 'None found');
      } catch (legacyError) {
        console.error('Neither mongosh nor mongo command found. Please install MongoDB shell tools.');
      }
    } else {
      console.error('Error:', error.message);
    }
  }
}

checkVPNSettings();