import requests

# replace the "demo" apikey below with your own key from https://www.alphavantage.co/support/#api-key
url = 'https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=IBM&apikey=4FP2HT8DCFM1650Z'
r = requests.get(url)
data = r.json()

print(data)