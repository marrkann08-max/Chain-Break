#include <WiFi.h>
#include <HTTPClient.h>
#include <Wire.h>
#include "secrets.h"

const uint8_t MPU_ADDR = 0x68;
const uint8_t WHO_AM_I = 0x75;
const uint8_t PWR_MGMT_1 = 0x6B;
const uint8_t ACCEL_CONFIG = 0x1C;
const uint8_t ACCEL_XOUT_H = 0x3B;
const float ACCEL_SCALE = 4096.0;

const int BUTTON_PIN = 4;
const float IMPACT_THRESHOLD_G = 2.5;
const unsigned long POST_INTERVAL_MS = 300;
const unsigned long WIFI_RETRY_MS = 5000;

unsigned long lastPostAt = 0;
unsigned long lastWifiAttemptAt = 0;
uint32_t sequenceNum = 0;
bool sensorHealthy = false;

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegister(uint8_t reg, uint8_t &value) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)1) != 1) return false;
  value = Wire.read();
  return true;
}

bool configureMpu() {
  uint8_t identity = 0;
  if (!readRegister(WHO_AM_I, identity) || identity != 0x68) return false;
  return writeRegister(PWR_MGMT_1, 0x00) && writeRegister(ACCEL_CONFIG, 0x10);
}

void connectWifi() {
  lastWifiAttemptAt = millis();
  Serial.print("Connecting to Wi-Fi");
  WiFi.disconnect();
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  const unsigned long startedAt = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - startedAt < 10000) {
    delay(250);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nConnected. IP: " + WiFi.localIP().toString());
  } else {
    Serial.println("\nWi-Fi unavailable; node will retry while the dashboard uses replay fallback.");
  }
}

bool readAcceleration(float &ax, float &ay, float &az, float &magnitudeG) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MPU_ADDR, (uint8_t)6) != 6) return false;

  int16_t rawX = (Wire.read() << 8) | Wire.read();
  int16_t rawY = (Wire.read() << 8) | Wire.read();
  int16_t rawZ = (Wire.read() << 8) | Wire.read();
  ax = rawX / ACCEL_SCALE;
  ay = rawY / ACCEL_SCALE;
  az = rawZ / ACCEL_SCALE;
  magnitudeG = sqrt(ax * ax + ay * ay + az * az);
  return true;
}

void sendPacket(float ax, float ay, float az, float magnitudeG, bool incident, const char *triggerSource) {
  if (WiFi.status() != WL_CONNECTED) return;

  HTTPClient http;
  http.setConnectTimeout(1500);
  http.setTimeout(2000);
  http.begin(SERVER_URL);
  http.addHeader("Content-Type", "application/json");

  sequenceNum++;
  String payload = "{";
  payload += "\"ts\":" + String(millis()) + ",";
  payload += "\"vehicle_id\":\"CHAINBREAK-NODE-01\",";
  payload += "\"speed_kph\":0,";
  payload += "\"track_distance_m\":5120,";
  payload += "\"imu_ax\":" + String(ax * 9.81, 2) + ",";
  payload += "\"imu_ay\":" + String(ay * 9.81, 2) + ",";
  payload += "\"imu_az\":" + String(az * 9.81, 2) + ",";
  payload += "\"accel_magnitude_ms2\":" + String(magnitudeG * 9.81, 2) + ",";
  payload += "\"incident\":" + String(incident ? "true" : "false") + ",";
  payload += "\"trigger_source\":\"" + String(triggerSource) + "\",";
  payload += "\"sequence\":" + String(sequenceNum) + ",";
  payload += "\"simulated\":false";
  payload += "}";

  const int statusCode = http.POST(payload);
  Serial.print("POST -> ");
  Serial.print(statusCode);
  Serial.print(" | incident: ");
  Serial.print(incident ? "TRUE" : "false");
  Serial.print(" | source: ");
  Serial.println(triggerSource);
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(500);
  pinMode(BUTTON_PIN, INPUT_PULLUP);
  Wire.begin(21, 22);

  sensorHealthy = configureMpu();
  Serial.println(sensorHealthy ? "MPU6050 ready at 0x68" : "MPU6050 not detected; check 3V3/GND/SDA21/SCL22");
  connectWifi();
}

void loop() {
  if (WiFi.status() != WL_CONNECTED && millis() - lastWifiAttemptAt >= WIFI_RETRY_MS) connectWifi();
  if (millis() - lastPostAt < POST_INTERVAL_MS) return;
  lastPostAt = millis();

  float ax = 0, ay = 0, az = 0, magnitudeG = 0;
  sensorHealthy = readAcceleration(ax, ay, az, magnitudeG);
  const bool buttonPressed = digitalRead(BUTTON_PIN) == LOW;
  const bool imuTriggered = sensorHealthy && magnitudeG > IMPACT_THRESHOLD_G;
  const bool incident = buttonPressed || imuTriggered;
  const char *triggerSource = buttonPressed ? "button" : (imuTriggered ? "imu" : "none");

  if (!sensorHealthy) {
    Serial.println("MPU6050 signal lost; packet withheld so ChainBreak declares degraded mode.");
    sensorHealthy = configureMpu();
    return;
  }

  sendPacket(ax, ay, az, magnitudeG, incident, triggerSource);
}
