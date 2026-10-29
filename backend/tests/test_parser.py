from app.parser import SerialParser


def test_json_reading_line_is_parsed():
    parser = SerialParser()
    event = parser.feed_line(
        '{"temperature":23.1,"humidity":54.2,"status":"OK"}'
    )
    assert event is not None
    assert event.temperature == 23.1
    assert event.humidity == 54.2
    assert event.sensor_error is False


def test_json_sensor_error_is_parsed_without_measurements():
    event = SerialParser().feed_line(
        '{"temperature":null,"humidity":null,"status":"SENSOR_ERROR"}'
    )
    assert event is not None
    assert event.sensor_error is True
    assert event.temperature is None
    assert event.humidity is None


def test_json_status_and_values_are_validated():
    parser = SerialParser()
    assert parser.feed_line('{"temperature":NaN,"humidity":45,"status":"OK"}') is None
    assert parser.feed_line('{"temperature":22,"humidity":45,"status":"ERROR"}') is None
    assert parser.feed_line('{"temperature":81,"humidity":45,"status":"OK"}') is None
    assert parser.feed_line('{"temperature":22,"humidity":101,"status":"OK"}') is None


def test_legacy_firmware_text_output_is_assembled():
    parser = SerialParser()
    assert parser.feed_line("Temperature: 23.1 C") is None
    event = parser.feed_line("Relative Humidity: 54.2 %")
    assert event is not None
    assert (event.temperature, event.humidity) == (23.1, 54.2)


def test_legacy_firmware_sensor_error_line():
    event = SerialParser().feed_line("STATUS: SENSOR ERROR")
    assert event is not None and event.sensor_error
