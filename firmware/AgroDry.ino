
#include <DHT.h>

// Sensor configuration
#define DHTPIN 4
#define DHTTYPE DHT22

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();

  delay(2000);
}

void loop() {
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();

  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("{\"temperature\":null,\"humidity\":null,\"status\":\"SENSOR_ERROR\"}");
  } else {
    Serial.print("{\"temperature\":");
    Serial.print(temperature, 1);
    Serial.print(",\"humidity\":");
    Serial.print(humidity, 1);
    Serial.println(",\"status\":\"OK\"}");
  }

  delay(2000);
}
