# LANAgent Advanced Capabilities Guide

## Web Scraping with Enhanced Features

### User Agent Support
The scraper plugin now supports custom user agents to bypass bot detection:

```javascript
// Using predefined user agents
scraper.scrape({ 
  url: "https://example.com", 
  options: { userAgent: "chrome" } 
})

// Available presets:
- "chrome" - Latest Chrome on Windows
- "firefox" - Latest Firefox on Windows  
- "safari" - Latest Safari on macOS
- "mobile" - iPhone Safari
- "bot" - LANAgent bot identifier
- "googlebot" - Googlebot crawler

// Using custom user agent string
scraper.scrape({ 
  url: "https://example.com", 
  options: { userAgent: "MyCustomBot/1.0" } 
})
```

### Combining with VPN for Anti-Blocking

When you encounter blocking or rate limiting, you can:

1. **Change VPN location before scraping**:
```
vpn.connect({ location: "us-den" })  // Connect to Denver
// Wait for connection
scraper.scrape({ url: "https://blocked-site.com", options: { userAgent: "firefox" } })
```

2. **Rotate through different strategies**:
- Try default Chrome user agent
- If blocked, switch to mobile user agent
- If still blocked, change VPN location
- Try with Googlebot user agent (some sites allow it)

### Example Anti-Blocking Workflow

```
// Attempt 1: Normal scrape
result = scraper.scrape({ url: "https://example.com" })

// If blocked (403/429 error)
if (result.error && result.error.includes("403")) {
  // Attempt 2: Mobile user agent
  result = scraper.scrape({ 
    url: "https://example.com", 
    options: { userAgent: "mobile" } 
  })
  
  // If still blocked
  if (result.error) {
    // Attempt 3: Change VPN and try again
    vpn.connect({ location: "uk-london" })
    // Wait 5 seconds for VPN
    result = scraper.scrape({ 
      url: "https://example.com", 
      options: { userAgent: "chrome" } 
    })
  }
}
```

### PDF Generation with User Agents

PDF generation also supports custom user agents:

```javascript
scraper.pdf({ 
  url: "https://example.com", 
  options: { 
    userAgent: "chrome",
    format: "A4" 
  } 
})
```

### Best Practices

1. **Start with standard user agents** - Try Chrome/Firefox first
2. **Use mobile for responsive sites** - Some sites have simpler mobile versions
3. **Rotate VPN locations** - Different regions may have different access
4. **Respect rate limits** - Add delays between requests
5. **Cache results** - The scraper caches by default for 5 minutes

### Available VPN Locations

Use `vpn.list()` to see all available locations. Common ones:
- US: us-nyc, us-den, us-sfo, us-dal
- Europe: uk-london, de-fra, nl-ams
- Asia: jp-tokyo, sg, hk

### Remember

- You have full control over user agents for all scraping operations
- VPN can be changed at any time to bypass geo-blocks
- Combine both for maximum effectiveness
- Always check robots.txt and respect site policies when possible