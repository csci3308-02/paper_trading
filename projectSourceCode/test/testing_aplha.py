import unittest
import requests
import json
from unittest.mock import patch

class TestAlphaVantageAPI(unittest.TestCase):
    def setUp(self):
        self.api_key = "4FP2HT8DCFM1650Z"
        self.base_url = "https://www.alphavantage.co/query"
        
    def test_api_connection(self):
        """Test basic API connectivity"""
        params = {
            "function": "GLOBAL_QUOTE",
            "symbol": "IBM",
            "apikey": self.api_key
        }
        response = requests.get(self.base_url, params=params)
        self.assertEqual(response.status_code, 200)
        
    def test_valid_data_structure(self):
        """Test if the API returns the expected data structure"""
        params = {
            "function": "GLOBAL_QUOTE",
            "symbol": "IBM",
            "apikey": self.api_key
        }
        response = requests.get(self.base_url, params=params)
        data = response.json()
        
        self.assertIn("Global Quote", data)
        quote_data = data["Global Quote"]
        expected_keys = [
            "01. symbol",
            "02. open",
            "03. high",
            "04. low",
            "05. price",
            "06. volume",
            "07. latest trading day",
            "08. previous close",
            "09. change",
            "10. change percent"
        ]
        for key in expected_keys:
            self.assertIn(key, quote_data)

    @patch('requests.get')
    def test_invalid_symbol(self, mock_get):
        """Test handling of invalid stock symbol"""
        # Mock response for invalid symbol
        mock_response = {
            "Error Message": "Invalid API call. Please retry or visit the documentation (https://www.alphavantage.co/documentation/) for GLOBAL_QUOTE."
        }
        mock_get.return_value.json.return_value = mock_response
        mock_get.return_value.status_code = 200

        params = {
            "function": "GLOBAL_QUOTE",
            "symbol": "INVALID_SYMBOL",
            "apikey": self.api_key
        }
        response = requests.get(self.base_url, params=params)
        data = response.json()
        
        self.assertIn("Error Message", data)

if __name__ == '__main__':
    unittest.main()