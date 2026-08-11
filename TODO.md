## Monitoring voltage
- It is essential to keep the supply voltage above 4.8V for reliable performance.
    - Note that the voltage from some USB chargers/power supplies can fall as low as 4.2V. This is because they are usually designed to charge a 3.7V LiPo battery, not to supply 5V to a computer.
- To monitor the Raspberry Pi’s PSU voltage you will need to use a multimeter to measure between the VCC and GND pins on the GPIO. 
- If the voltage drops below 4.63V (±5%), the Arm cores and the GPU will be throttled back, and a message indicating the low voltage state will be added to the kernel log. The Raspberry Pi 5 PMIC has built in ADCs that allow the supply voltage to be measured.

>To view the current supply voltage, run the following command:

```bash
vcgencmd pmic_read_adc EXT5V_V
```

## Network Manager
You can use the built-in Network Manager CLI (nmcli) to access details about your network. Run the following command:

```bash
nmcli device show
```
