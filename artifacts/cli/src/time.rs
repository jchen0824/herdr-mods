use std::time::{SystemTime, UNIX_EPOCH};

const SECONDS_PER_MINUTE: u64 = 60;
const SECONDS_PER_HOUR: u64 = 3_600;
const SECONDS_PER_DAY: u64 = 86_400;
const DAYS_FROM_0000_03_01_TO_1970_01_01: i64 = 719_468;
const YEARS_PER_ERA: i64 = 400;
const DAYS_PER_ERA: i64 = 146_097;
const DAYS_PER_100_YEARS: i64 = 36_524;
const DAYS_PER_4_YEARS: i64 = 1_461;
const DAYS_PER_YEAR: i64 = 365;
const DAYS_PER_5_MONTHS_FROM_MARCH: i64 = 153;
const MONTHS_PER_YEAR: i64 = 12;
const MARCH: i64 = 3;

pub fn now() -> String {
    rfc3339(SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs()))
}

pub fn rfc3339(secs: u64) -> String {
    let (year, month, day) = civil_from_days((secs / SECONDS_PER_DAY) as i64);
    let of_day = secs % SECONDS_PER_DAY;
    let (hour, minute, second) =
        (of_day / SECONDS_PER_HOUR, of_day % SECONDS_PER_HOUR / SECONDS_PER_MINUTE, of_day % SECONDS_PER_MINUTE);
    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z")
}

fn civil_from_days(days_since_epoch: i64) -> (i64, i64, i64) {
    let days = days_since_epoch + DAYS_FROM_0000_03_01_TO_1970_01_01;
    let (era, day_of_era) = (days.div_euclid(DAYS_PER_ERA), days.rem_euclid(DAYS_PER_ERA));
    let year_of_era = (day_of_era - day_of_era / (DAYS_PER_4_YEARS - 1) + day_of_era / DAYS_PER_100_YEARS
        - day_of_era / (DAYS_PER_ERA - 1))
        / DAYS_PER_YEAR;
    let day_of_year = day_of_era - (DAYS_PER_YEAR * year_of_era + year_of_era / 4 - year_of_era / 100);
    let months_since_march = (5 * day_of_year + 2) / DAYS_PER_5_MONTHS_FROM_MARCH;
    let day = day_of_year - (DAYS_PER_5_MONTHS_FROM_MARCH * months_since_march + 2) / 5 + 1;
    let month = (months_since_march + MARCH - 1) % MONTHS_PER_YEAR + 1;
    let year = era * YEARS_PER_ERA + year_of_era + i64::from(month < MARCH);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::rfc3339;

    #[test]
    fn formats_the_epoch_a_leap_day_and_a_time_of_day() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339(951_868_800 + 3_723), "2000-03-01T01:02:03Z");
    }
}
