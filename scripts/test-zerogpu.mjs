import { Client, handle_file } from '@gradio/client';
import fs from 'fs';

const HF_TOKEN = process.env.HUGGINGFACE_TOKEN || process.env.HF_TOKEN;

// Create test image
const pngBuf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFklEQVQYV2P8z8BQz0BFwMgwqpBiigBPCwELz3v/fAAAAABJRU5ErkJggg==', 'base64');
fs.writeFileSync('/tmp/test.png', pngBuf);

// Test 1: Try with custom fetch that adds cookie header
console.log('=== Test 1: TRELLIS with token as cookie ===');
try {
    const customFetch = (url, options = {}) => {
        options.headers = options.headers || {};
        if (typeof options.headers.set === 'function') {
            options.headers.set('Cookie', 'token=' + HF_TOKEN);
        } else {
            options.headers['Cookie'] = 'token=' + HF_TOKEN;
        }
        return fetch(url, options);
    };

    const client = await Client.connect('trellis-community/TRELLIS', {
        hf_token: HF_TOKEN,
        fetch: customFetch
    });
    console.log('Connected. Generating...');
    const start = Date.now();
    const result = await client.predict('/generate_and_extract_glb', {
        image: handle_file('/tmp/test.png'),
        multiimages: [],
        seed: 0,
        ss_guidance_strength: 7.5,
        ss_sampling_steps: 12,
        slat_guidance_strength: 3.0,
        slat_sampling_steps: 12,
        multiimage_algo: 'stochastic',
        mesh_simplify: 0.95,
        texture_size: '1024'
    });
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log('SUCCESS in ' + elapsed + 's! Items:', result.data?.length);
    console.log('Preview:', JSON.stringify(result.data).slice(0, 300));
    client.close?.();
} catch (err) {
    console.log('FAILED:', err.message?.slice(0, 400));
}

// Test 2: Get HF session cookie first, then use it
console.log('\n=== Test 2: Get HF login cookie, then connect ===');
try {
    // Get OAuth/login cookie from HF
    const loginRes = await fetch('https://huggingface.co/oauth/authorize?client_id=spaces&redirect_uri=https://huggingface.co/spaces', {
        headers: { 'Authorization': 'Bearer ' + HF_TOKEN },
        redirect: 'manual'
    });
    console.log('Login status:', loginRes.status);
    const cookies = loginRes.headers.getSetCookie?.() || [];
    console.log('Cookies received:', cookies.length, cookies.map(c => c.split('=')[0]).join(', '));
} catch(e) { console.log('Login error:', e.message?.slice(0, 200)); }

console.log('\nDone');
