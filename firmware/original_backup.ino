#include <DHT.h>

// Sensor configuration
#define DHTPIN 4
#define DHTTYPE DHT22

// Demonstration thresholds
const float MAX_TEMPERATURE = 40.0;
const float MAX_HUMIDITY = 75.0;

DHT dht(DHTPIN, DHTTYPE);

void setup() {
  Serial.begin(115200);
  dht.begin();

  Serial.println();
  Serial.println("====================================");
  Serial.println("     AgroDry: Smart Dryer Monitoring");
  Serial.println("====================================");
  Serial.println("Starting sensor monitoring...");

  delay(2000);
}

void loop() {
  float temperature = dht.readTemperature();
  float humidity = dht.readHumidity();

  Serial.println();

  if (isnan(temperature) || isnan(humidity)) {
    Serial.println("STATUS: SENSOR ERROR");
    Serial.println("Check DHT22 wiring and connections.");
  } else {
    Serial.println("----- ENVIRONMENTAL READINGS -----");

    Serial.print("Temperature: ");
    Serial.print(temperature, 1);
    Serial.println(" C");

    Serial.print("Relative Humidity: ");
    Serial.print(humidity, 1);
    Serial.println(" %");

    bool highTemperature =
        temperature > MAX_TEMPERATURE;

    bool highHumidity =
        humidity > MAX_HUMIDITY;

    if (highTemperature || highHumidity) {
      Serial.println("STATUS: WARNING");

      if (highTemperature) {
        Serial.println("Reason: High temperature");
      }

      if (highHumidity) {
        Serial.println("Reason: High humidity");
      }
    } else {
      Serial.println("STATUS: NORMAL");
      Serial.println(
          "Conditions are within configured limits."
      );
    }

    Serial.println("----------------------------------");
  }

  delay(2000);
}
