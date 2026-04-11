export const sketchTemplates = {
  blink: {
    name: 'Basic Blink',
    description: 'Blinks the built-in LED',
    code: `void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
}

void loop() {
  digitalWrite(LED_BUILTIN, HIGH);
  delay(1000);
  digitalWrite(LED_BUILTIN, LOW);
  delay(1000);
}`
  },

  serialEcho: {
    name: 'Serial Echo',
    description: 'Echoes data received via serial',
    code: `void setup() {
  Serial.begin(9600);
  Serial.println("Serial Echo Ready!");
}

void loop() {
  if (Serial.available() > 0) {
    char incomingByte = Serial.read();
    Serial.print("Echo: ");
    Serial.println(incomingByte);
  }
}`
  },

  temperatureSensor: {
    name: 'Temperature Sensor (DHT22)',
    description: 'Reads temperature and humidity from DHT22',
    code: `#include <DHT.h>

#define DHTPIN 2
#define DHTTYPE DHT22

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(9600);
  dht.begin();
}

void loop() {
  delay(2000);
  
  float humidity = dht.readHumidity();
  float temperature = dht.readTemperature();
  
  if (isnan(humidity) || isnan(temperature)) {
    Serial.println("Failed to read from DHT sensor!");
    return;
  }
  
  Serial.print("Humidity: ");
  Serial.print(humidity);
  Serial.print("% Temperature: ");
  Serial.print(temperature);
  Serial.println("°C");
}`
  },

  wifiScan: {
    name: 'WiFi Scanner (ESP32/ESP8266)',
    description: 'Scans for nearby WiFi networks',
    code: `#ifdef ESP32
  #include <WiFi.h>
#else
  #include <ESP8266WiFi.h>
#endif

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
  delay(100);
}

void loop() {
  Serial.println("Scanning WiFi networks...");
  
  int n = WiFi.scanNetworks();
  if (n == 0) {
    Serial.println("No networks found");
  } else {
    Serial.print(n);
    Serial.println(" networks found:");
    
    for (int i = 0; i < n; ++i) {
      Serial.print(i + 1);
      Serial.print(": ");
      Serial.print(WiFi.SSID(i));
      Serial.print(" (");
      Serial.print(WiFi.RSSI(i));
      Serial.print(" dBm) ");
      Serial.println((WiFi.encryptionType(i) == WIFI_AUTH_OPEN) ? "Open" : "Encrypted");
      delay(10);
    }
  }
  
  Serial.println("");
  delay(5000);
}`
  },

  webServer: {
    name: 'Simple Web Server (ESP32/ESP8266)',
    description: 'Creates a simple web server',
    code: `#ifdef ESP32
  #include <WiFi.h>
  #include <WebServer.h>
  WebServer server(80);
#else
  #include <ESP8266WiFi.h>
  #include <ESP8266WebServer.h>
  ESP8266WebServer server(80);
#endif

const char* ssid = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";

void handleRoot() {
  String html = "<html><body>";
  html += "<h1>ESP Web Server</h1>";
  html += "<p>Uptime: " + String(millis()/1000) + " seconds</p>";
  html += "<p><a href='/led/on'>LED ON</a> | <a href='/led/off'>LED OFF</a></p>";
  html += "</body></html>";
  server.send(200, "text/html", html);
}

void handleLedOn() {
  digitalWrite(LED_BUILTIN, HIGH);
  server.send(200, "text/plain", "LED is ON");
}

void handleLedOff() {
  digitalWrite(LED_BUILTIN, LOW);
  server.send(200, "text/plain", "LED is OFF");
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_BUILTIN, OUTPUT);
  
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("");
  Serial.print("Connected to ");
  Serial.println(ssid);
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());
  
  server.on("/", handleRoot);
  server.on("/led/on", handleLedOn);
  server.on("/led/off", handleLedOff);
  
  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  server.handleClient();
}`
  },

  mqtt: {
    name: 'MQTT Client (ESP32/ESP8266)',
    description: 'Connects to MQTT broker and publishes sensor data',
    code: `#ifdef ESP32
  #include <WiFi.h>
#else
  #include <ESP8266WiFi.h>
#endif
#include <PubSubClient.h>

const char* ssid = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";
const char* mqtt_server = "YOUR_MQTT_BROKER";
const char* mqtt_topic = "home/sensor/temperature";

WiFiClient espClient;
PubSubClient client(espClient);

void setup_wifi() {
  delay(10);
  Serial.println();
  Serial.print("Connecting to ");
  Serial.println(ssid);
  
  WiFi.begin(ssid, password);
  
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  
  Serial.println("");
  Serial.println("WiFi connected");
  Serial.println("IP address: ");
  Serial.println(WiFi.localIP());
}

void reconnect() {
  while (!client.connected()) {
    Serial.print("Attempting MQTT connection...");
    String clientId = "ESP-" + String(random(0xffff), HEX);
    
    if (client.connect(clientId.c_str())) {
      Serial.println("connected");
      client.subscribe("home/control/+");
    } else {
      Serial.print("failed, rc=");
      Serial.print(client.state());
      Serial.println(" try again in 5 seconds");
      delay(5000);
    }
  }
}

void callback(char* topic, byte* payload, unsigned int length) {
  Serial.print("Message arrived [");
  Serial.print(topic);
  Serial.print("] ");
  
  String message;
  for (int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.println(message);
  
  // Handle commands
  if (String(topic) == "home/control/led") {
    if (message == "ON") {
      digitalWrite(LED_BUILTIN, HIGH);
    } else if (message == "OFF") {
      digitalWrite(LED_BUILTIN, LOW);
    }
  }
}

void setup() {
  pinMode(LED_BUILTIN, OUTPUT);
  Serial.begin(115200);
  setup_wifi();
  client.setServer(mqtt_server, 1883);
  client.setCallback(callback);
}

void loop() {
  if (!client.connected()) {
    reconnect();
  }
  client.loop();
  
  static unsigned long lastMsg = 0;
  unsigned long now = millis();
  
  if (now - lastMsg > 5000) {
    lastMsg = now;
    
    // Simulate temperature reading
    float temperature = 20.0 + (random(100) / 10.0);
    
    String payload = "{\"temperature\":" + String(temperature) + ",\"unit\":\"C\"}";
    Serial.print("Publishing: ");
    Serial.println(payload);
    
    client.publish(mqtt_topic, payload.c_str());
  }
}`
  },

  servo: {
    name: 'Servo Control',
    description: 'Controls a servo motor via serial commands',
    code: `#include <Servo.h>

Servo myservo;
int servoPin = 9;

void setup() {
  Serial.begin(9600);
  myservo.attach(servoPin);
  myservo.write(90); // Center position
  Serial.println("Servo Ready! Send angle (0-180) or 'sweep'");
}

void loop() {
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\\n');
    command.trim();
    
    if (command == "sweep") {
      Serial.println("Sweeping...");
      for (int angle = 0; angle <= 180; angle += 5) {
        myservo.write(angle);
        delay(30);
      }
      for (int angle = 180; angle >= 0; angle -= 5) {
        myservo.write(angle);
        delay(30);
      }
      Serial.println("Sweep complete!");
    } else {
      int angle = command.toInt();
      if (angle >= 0 && angle <= 180) {
        myservo.write(angle);
        Serial.print("Servo moved to: ");
        Serial.println(angle);
      } else {
        Serial.println("Invalid angle! Use 0-180 or 'sweep'");
      }
    }
  }
}`
  },

  ultrasonic: {
    name: 'Ultrasonic Distance Sensor',
    description: 'Measures distance using HC-SR04',
    code: `const int trigPin = 9;
const int echoPin = 10;

void setup() {
  Serial.begin(9600);
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  Serial.println("Ultrasonic Distance Sensor Ready!");
}

void loop() {
  // Clear the trigger pin
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  
  // Send 10us pulse
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);
  
  // Read echo pin
  long duration = pulseIn(echoPin, HIGH);
  
  // Calculate distance in cm
  float distance = duration * 0.034 / 2;
  
  Serial.print("Distance: ");
  Serial.print(distance);
  Serial.println(" cm");
  
  // Warning if too close
  if (distance < 10) {
    Serial.println("WARNING: Object very close!");
  }
  
  delay(500);
}`
  },

  neopixel: {
    name: 'NeoPixel LED Control',
    description: 'Controls WS2812B RGB LEDs',
    code: `#include <Adafruit_NeoPixel.h>

#define LED_PIN 6
#define LED_COUNT 16

Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);

void setup() {
  Serial.begin(9600);
  strip.begin();
  strip.show(); // Initialize all pixels to off
  strip.setBrightness(50);
  Serial.println("NeoPixel Ready! Commands: rainbow, chase, solid R G B");
}

void loop() {
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\\n');
    command.trim();
    
    if (command == "rainbow") {
      rainbowCycle(20);
    } else if (command == "chase") {
      theaterChase(strip.Color(127, 127, 127), 50);
    } else if (command.startsWith("solid")) {
      // Parse "solid R G B" command
      int r, g, b;
      if (sscanf(command.c_str(), "solid %d %d %d", &r, &g, &b) == 3) {
        setColor(strip.Color(r, g, b));
        Serial.println("Color set!");
      }
    } else if (command == "off") {
      setColor(strip.Color(0, 0, 0));
      Serial.println("LEDs off");
    }
  }
}

void setColor(uint32_t color) {
  for (int i = 0; i < strip.numPixels(); i++) {
    strip.setPixelColor(i, color);
  }
  strip.show();
}

void rainbowCycle(uint8_t wait) {
  for (uint16_t j = 0; j < 256 * 5; j++) {
    for (uint16_t i = 0; i < strip.numPixels(); i++) {
      strip.setPixelColor(i, Wheel(((i * 256 / strip.numPixels()) + j) & 255));
    }
    strip.show();
    delay(wait);
  }
}

void theaterChase(uint32_t color, uint8_t wait) {
  for (int j = 0; j < 10; j++) {
    for (int q = 0; q < 3; q++) {
      for (uint16_t i = 0; i < strip.numPixels(); i += 3) {
        strip.setPixelColor(i + q, color);
      }
      strip.show();
      delay(wait);
      for (uint16_t i = 0; i < strip.numPixels(); i += 3) {
        strip.setPixelColor(i + q, 0);
      }
    }
  }
}

uint32_t Wheel(byte WheelPos) {
  WheelPos = 255 - WheelPos;
  if (WheelPos < 85) {
    return strip.Color(255 - WheelPos * 3, 0, WheelPos * 3);
  }
  if (WheelPos < 170) {
    WheelPos -= 85;
    return strip.Color(0, WheelPos * 3, 255 - WheelPos * 3);
  }
  WheelPos -= 170;
  return strip.Color(WheelPos * 3, 255 - WheelPos * 3, 0);
}`
  },

  otaUpdate: {
    name: 'OTA Update (ESP32/ESP8266)',
    description: 'Enables OTA updates for ESP32/ESP8266',
    code: `#ifdef ESP32
  #include <WiFi.h>
  #include <ArduinoOTA.h>
#else
  #include <ESP8266WiFi.h>
  #include <ArduinoOTA.h>
#endif

const char* ssid = "YOUR_SSID";
const char* password = "YOUR_PASSWORD";

void setup() {
  Serial.begin(115200);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("");
  Serial.print("Connected to ");
  Serial.println(ssid);
  Serial.print("IP address: ");
  Serial.println(WiFi.localIP());

  ArduinoOTA.onStart([]() {
    String type;
    if (ArduinoOTA.getCommand() == U_FLASH) {
      type = "sketch";
    } else { // U_SPIFFS
      type = "filesystem";
    }
    Serial.println("Start updating " + type);
  });
  ArduinoOTA.onEnd([]() {
    Serial.println("\\nEnd");
  });
  ArduinoOTA.onProgress([](unsigned int progress, unsigned int total) {
    Serial.printf("Progress: %u%%\\r", (progress / (total / 100)));
  });
  ArduinoOTA.onError([](ota_error_t error) {
    Serial.printf("Error[%u]: ", error);
    if (error == OTA_AUTH_ERROR) {
      Serial.println("Auth Failed");
    } else if (error == OTA_BEGIN_ERROR) {
      Serial.println("Begin Failed");
    } else if (error == OTA_CONNECT_ERROR) {
      Serial.println("Connect Failed");
    } else if (error == OTA_RECEIVE_ERROR) {
      Serial.println("Receive Failed");
    } else if (error == OTA_END_ERROR) {
      Serial.println("End Failed");
    }
  });

  ArduinoOTA.begin();
  Serial.println("OTA Ready");
}

void loop() {
  ArduinoOTA.handle();
}`
  },

  arduinoNanoBlink: {
    name: 'Arduino Nano Blink',
    description: 'Blinks an LED on Arduino Nano',
    code: `// Arduino Nano LED Blink
// LED is connected to pin 13 (same as Arduino Uno)

void setup() {
  // Initialize digital pin 13 as an output
  pinMode(13, OUTPUT);
  
  // Initialize serial communication
  Serial.begin(9600);
  Serial.println("Arduino Nano Blink Example");
  Serial.println("LED connected to pin 13");
}

void loop() {
  digitalWrite(13, HIGH);   // Turn the LED on
  Serial.println("LED ON");
  delay(1000);              // Wait for a second
  
  digitalWrite(13, LOW);    // Turn the LED off
  Serial.println("LED OFF");
  delay(1000);              // Wait for a second
}`
  },

  arduinoNanoAnalogRead: {
    name: 'Arduino Nano Analog Read',
    description: 'Reads analog values from A0-A7 pins',
    code: `// Arduino Nano Analog Read Example
// The Arduino Nano has 8 analog inputs (A0-A7)

void setup() {
  Serial.begin(9600);
  Serial.println("Arduino Nano Analog Read Example");
  Serial.println("Reading from analog pins A0-A3");
}

void loop() {
  // Read analog values from pins A0 to A3
  for (int analogPin = 0; analogPin < 4; analogPin++) {
    int sensorValue = analogRead(analogPin);
    
    // Convert the analog reading to voltage
    float voltage = sensorValue * (5.0 / 1023.0);
    
    Serial.print("A");
    Serial.print(analogPin);
    Serial.print(": ");
    Serial.print(sensorValue);
    Serial.print(" (");
    Serial.print(voltage);
    Serial.println("V)");
  }
  
  Serial.println("---");
  delay(1000);
}`
  },

  raspberryPiPicoBlink: {
    name: 'Raspberry Pi Pico Blink',
    description: 'Blinks the onboard LED on Raspberry Pi Pico',
    code: `// Raspberry Pi Pico LED Blink
// Uses the onboard LED connected to GP25

const int LED_PIN = 25;  // Onboard LED is on GP25

void setup() {
  // Initialize the LED pin as output
  pinMode(LED_PIN, OUTPUT);
  
  // Initialize serial communication
  Serial.begin(115200);
  while (!Serial) {
    ; // Wait for serial port to connect
  }
  
  Serial.println("Raspberry Pi Pico Blink Example");
  Serial.println("Onboard LED on GP25");
}

void loop() {
  digitalWrite(LED_PIN, HIGH);  // Turn LED on
  Serial.println("LED ON");
  delay(500);
  
  digitalWrite(LED_PIN, LOW);   // Turn LED off
  Serial.println("LED OFF");
  delay(500);
}`
  },

  raspberryPiPicoTemperature: {
    name: 'Raspberry Pi Pico Temperature',
    description: 'Reads the internal temperature sensor',
    code: `// Raspberry Pi Pico Internal Temperature Sensor
// The Pico has an internal temperature sensor connected to ADC4

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    ; // Wait for serial port to connect
  }
  
  Serial.println("Raspberry Pi Pico Temperature Sensor");
  Serial.println("Reading internal temperature...");
  
  // Enable the onboard temperature sensor
  analogReadResolution(12);  // 12-bit resolution
}

void loop() {
  // Read the raw ADC value from the temperature sensor
  int rawValue = analogRead(4);  // ADC4 is the temperature sensor
  
  // Convert to voltage (3.3V reference, 12-bit ADC)
  float voltage = rawValue * (3.3 / 4095.0);
  
  // Convert voltage to temperature using RP2040 formula
  // Temperature = 27 - (voltage - 0.706) / 0.001721
  float temperatureC = 27.0 - (voltage - 0.706) / 0.001721;
  float temperatureF = (temperatureC * 9.0 / 5.0) + 32.0;
  
  Serial.print("Raw ADC: ");
  Serial.print(rawValue);
  Serial.print(", Voltage: ");
  Serial.print(voltage);
  Serial.print("V, Temp: ");
  Serial.print(temperatureC);
  Serial.print("°C (");
  Serial.print(temperatureF);
  Serial.println("°F)");
  
  delay(1000);
}`
  },

  raspberryPiPicoPWM: {
    name: 'Raspberry Pi Pico PWM',
    description: 'PWM control for LED brightness',
    code: `// Raspberry Pi Pico PWM LED Control
// Control LED brightness using PWM

const int LED_PIN = 15;  // External LED on GP15
const int POT_PIN = 26;  // Potentiometer on GP26 (ADC0)

void setup() {
  pinMode(LED_PIN, OUTPUT);
  
  Serial.begin(115200);
  while (!Serial) {
    ; // Wait for serial port to connect
  }
  
  Serial.println("Raspberry Pi Pico PWM Example");
  Serial.println("LED on GP15, Potentiometer on GP26");
}

void loop() {
  // Read potentiometer value (0-4095 for 12-bit ADC)
  int potValue = analogRead(POT_PIN);
  
  // Map to PWM range (0-255)
  int brightness = map(potValue, 0, 4095, 0, 255);
  
  // Set LED brightness
  analogWrite(LED_PIN, brightness);
  
  // Calculate percentage
  int percentage = map(brightness, 0, 255, 0, 100);
  
  Serial.print("Potentiometer: ");
  Serial.print(potValue);
  Serial.print(", Brightness: ");
  Serial.print(brightness);
  Serial.print(" (");
  Serial.print(percentage);
  Serial.println("%)");
  
  delay(100);
}`
  }
};

/**
 * Retrieves a sketch template by name.
 * @param {string} name - The name of the template.
 * @returns {object|null} The template object or null if not found.
 */
export function getTemplate(name) {
  return sketchTemplates[name] || null;
}

/**
 * Lists all available sketch templates.
 * @returns {Array} An array of template metadata.
 */
export function listTemplates() {
  return Object.keys(sketchTemplates).map(key => ({
    id: key,
    name: sketchTemplates[key].name,
    description: sketchTemplates[key].description
  }));
}